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
  // Board outline. Coordinates keep their meaning (keep_origin, default): a polygon is used as given, and only when
  // it reaches below x = 0 / y = 0 is everything (parts, copper, holes, keep-outs, texts) moved by the offset returned.
  // circle {d, flat: {side, at}}: a round board of diameter d (centre d/2, d/2 unless cx / cy), optionally with a flat
  // edge (side left / right / top / bottom, at = that edge's x or y); rounded_rect = rounded.
  // the board in tool results: size and shape type only (the outline points with verbose / get_board_outline)
  function boardBrief(board = Model.S.board) {
    const sh = board.shape || { type: 'rect' };
    return Object.assign({ w: board.w, h: board.h, shape: sh.type || 'rect' }, sh.r ? { corner_radius: sh.r } : {}, sh.pts ? { outline_points: sh.pts.length } : {});
  }
  function setBoardShape(o = {}) {
    const S = Model.S, b = S.board;
    let type = o.shape || o.type || 'rect';
    if (type === 'rounded_rect') type = 'rounded';
    if (!['rect', 'rounded', 'ellipse', 'polygon', 'circle'].includes(type)) throw new Error('shape must be rect, rounded (rounded_rect), ellipse, circle or polygon');
    if (type === 'circle') {
      const d = +(o.d || o.diameter || o.width || b.w); if (!(d > 0)) throw new Error('circle needs d (diameter, mm)');
      const cx = o.cx != null ? +o.cx : d / 2, cy = o.cy != null ? +o.cy : d / 2, r = d / 2, f = o.flat, pts = [];
      for (let k = 0; k < 120; k++) {
        const a = k / 120 * 2 * Math.PI; let x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
        if (f && f.side) {   // a flat: points beyond the cut line land on it
          const at = +(f.at ?? f.at_x ?? f.at_y);
          if (f.side === 'left') x = Math.max(x, at); else if (f.side === 'right') x = Math.min(x, at); else if (f.side === 'top') y = Math.max(y, at); else if (f.side === 'bottom') y = Math.min(y, at);
        }
        const q = [+x.toFixed(3), +y.toFixed(3)], last = pts[pts.length - 1];
        if (!last || Math.hypot(q[0] - last[0], q[1] - last[1]) > 1e-3) pts.push(q);
      }
      // drop points in the middle of the flat (collinear)
      const clean = pts.filter((q, i) => { const a = pts[(i - 1 + pts.length) % pts.length], c = pts[(i + 1) % pts.length]; return Math.abs((q[0] - a[0]) * (c[1] - q[1]) - (q[1] - a[1]) * (c[0] - q[0])) > 1e-6; });
      return Object.assign(setBoardShape(Object.assign({}, o, { shape: 'polygon', points: clean, corner_radius: o.corner_radius || 0 })), { requested: 'circle' + (f ? ' with a flat ' + f.side : '') });
    }
    if (o.width > 0) b.w = +o.width; if (o.height > 0) b.h = +o.height;
    const sh = { type };
    let offset = null;
    if (type === 'rounded') sh.r = Math.max(0.5, +(o.corner_radius ?? o.r ?? 3));
    if (type === 'polygon') {
      const pts = (o.points || o.pts || []).map(q => [+q[0], +q[1]]);
      if (pts.length < 3) throw new Error('polygon needs at least 3 points');
      const minx = Math.min(...pts.map(q => q[0])), miny = Math.min(...pts.map(q => q[1]));
      // keep_origin (default): shift only what reaches below 0; keep_origin false (or normalize true): the polygon starts at 0, 0
      const toZero = o.keep_origin === false || o.normalize === true;
      const dx = toZero ? -minx : Math.max(0, -minx), dy = toZero ? -miny : Math.max(0, -miny);
      if (dx || dy) { for (const q of pts) { q[0] += dx; q[1] += dy; } shiftAll(dx, dy); offset = [+dx.toFixed(3), +dy.toFixed(3)]; }
      sh.pts = pts.map(q => [+q[0].toFixed(3), +q[1].toFixed(3)]); sh.r = +(o.corner_radius ?? o.r ?? 0);
      b.w = +Math.max(...sh.pts.map(q => q[0])).toFixed(3); b.h = +Math.max(...sh.pts.map(q => q[1])).toFixed(3);
    }
    b.shape = sh;
    const fit = o.auto_fit ? autoFit() : undefined, mg = placed().length ? edgeMargins() : null;
    return { board: { w: b.w, h: b.h, shape: sh.type, corner_radius: sh.r }, offset_applied: offset || undefined,
      note: offset ? `Everything on the board was moved by (${offset[0]}, ${offset[1]}) mm so the outline starts at 0` : undefined,
      outside: placed().filter(c => !fpInside(c)).map(c => c.ref), auto_fit: fit, margin_mm: mg ? mg.closest : undefined, too_close_to_edge: mg && mg.too_close.length ? mg.too_close : undefined };
  }
  // move the whole board content (parts, copper, holes, keep-outs, free texts, board label)
  function shiftAll(dx, dy) {
    const S = Model.S, P = S.pcb, mv = q => [+(q[0] + dx).toFixed(4), +(q[1] + dy).toFixed(4)];
    for (const c of placed()) { c.pcb.x = +(c.pcb.x + dx).toFixed(4); c.pcb.y = +(c.pcb.y + dy).toFixed(4); }
    for (const t of P.traces) t.pts = t.pts.map(mv);
    for (const v of P.vias) { v.x = +(v.x + dx).toFixed(4); v.y = +(v.y + dy).toFixed(4); }
    for (const pr of P.pours || []) if (pr.pts) pr.pts = pr.pts.map(mv);
    for (const h of P.holes || []) { h.x = +(h.x + dx).toFixed(3); h.y = +(h.y + dy).toFixed(3); }
    for (const k of P.keepouts || []) k.pts = k.pts.map(mv);
    for (const t of P.texts || []) { t.x = +(+t.x + dx).toFixed(3); t.y = +(+t.y + dy).toFixed(3); }
    if (P.boardLabel && P.boardLabel.x != null) { P.boardLabel.x = +(P.boardLabel.x + dx).toFixed(3); P.boardLabel.y = +(P.boardLabel.y + dy).toFixed(3); }
  }
  // the outline of a part's body for "is it on the board": a round single-pad part (electrode, round test pad) is the circle
  // inside its box, everything else its box. inset > 0 grows it.
  function bodyPoints(c, inset = 0) {
    const fp = Lib.footprint(c.footprint), b = fpBox(c, inset);
    if (fp && fp.pads.length === 1 && fp.pads[0].shape === 'round') {
      const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2, r = Math.min(b[2] - b[0], b[3] - b[1]) / 2, out = [];
      for (let k = 0; k < 24; k++) out.push([cx + r * Math.cos(k * Math.PI / 12), cy + r * Math.sin(k * Math.PI / 12)]);
      return out;
    }
    return [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [(b[0] + b[2]) / 2, b[1]], [(b[0] + b[2]) / 2, b[3]], [b[0], (b[1] + b[3]) / 2], [b[2], (b[1] + b[3]) / 2]];
  }
  function fpInside(c) { const poly = boardPoly(); return bodyPoints(c, -0.1).every(q => inPoly(q[0], q[1], poly)); }

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
  // clip a polygon to x/y limits (Sutherland–Hodgman)
  function clipPoly(pts, c) {
    let out = pts.slice();
    const edges = [['x', '>=', c.x_min], ['x', '<=', c.x_max], ['y', '>=', c.y_min], ['y', '<=', c.y_max]].filter(e => e[2] != null && isFinite(+e[2]));
    for (const [ax, op, v0] of edges) {
      const v = +v0, k = ax === 'x' ? 0 : 1, inside = q => op === '>=' ? q[k] >= v - 1e-9 : q[k] <= v + 1e-9, res = [];
      for (let i = 0; i < out.length; i++) {
        const a = out[i], b = out[(i + 1) % out.length], ia = inside(a), ib = inside(b);
        if (ia) res.push(a);
        if (ia !== ib) { const t = (v - a[k]) / (b[k] - a[k]); res.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
      }
      out = res; if (out.length < 3) return [];
    }
    return out.map(q => [+q[0].toFixed(4), +q[1].toFixed(4)]);
  }
  // pour outline: its polygon, or the board outline (whole) — optionally clipped ({x_max: 21.3} …): then it follows outline changes
  const pourPoly = pr => { const base = pr.whole || !pr.pts ? boardPoly() : pr.pts; return pr.clip ? clipPoly(base, pr.clip) : base; };
  // ---------- keep-out areas: no tracks / vias / copper pour (and optionally no parts) inside, on one or both layers ----------
  // { name, layer: 'F' | 'B' | 'both', pts: polygon (board mm), tracks, vias, pours, parts }
  // keep-outs made from a part (ref, optionally one end of it) are recomputed from where the part is now
  // keep-outs: the board's own, plus (rule epKeepout, on by default) one under every exposed centre pad (QFN / DFN paddle)
  // on the other layer — no tracks or vias of other nets there, pour allowed; thermal vias of the pad are exempt
  let epKoMemo = { key: null, list: [] };
  function epKeepouts() {
    const S = Model.S; if (!S.pcb || rules().epKeepout === false || rules().layers === 1) return [];
    // parts whose automatic keep-out the user removed: S.pcb.epKeepoutOff [refs]
    const off = new Set(S.pcb.epKeepoutOff || []), cs = placed().filter(c => !off.has(c.ref)), key = cs.map(c => c.ref + ',' + c.footprint + ',' + c.pcb.x + ',' + c.pcb.y + ',' + (c.pcb.rot || 0) + ',' + (c.pcb.side || 'F')).join(';');
    if (epKoMemo.key === key) return epKoMemo.list;
    const list = [], idx = Model.pinIndex();
    for (const c of cs) { const fp = Lib.footprint(c.footprint); if (!fp) continue; const ep = exposedPads(fp); if (!ep.size) continue;
      for (const p of padsOf(c, idx)) if (ep.has(p.num) && !p.drill) { const m = 0.1, x0 = p.x - p.w / 2 - m, y0 = p.y - p.h / 2 - m, x1 = p.x + p.w / 2 + m, y1 = p.y + p.h / 2 + m;
        list.push({ name: `under ${c.ref} centre pad`, layer: isBottom(c) ? 'F' : 'B', pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], tracks: true, vias: true, pours: false, parts: false, auto: true, epRef: c.ref, epNet: p.net || null }); } }
    epKoMemo = { key, list }; return list;
  }
  const keepouts = () => ((Model.S.pcb && Model.S.pcb.keepouts) || []).map(k => k.ref ? Object.assign({}, k, { pts: refKeepoutPts(k) || k.pts }) : k).concat(epKeepouts());
  function refKeepoutPts(o) {
    const S = Model.S, c = Model.comp(o.ref); if (!c || !c.pcb || !Lib.footprint(c.footprint)) return null;
    let b = fpBox(c, +o.margin || 0);
    if (o.end) {
      const d = +(o.depth ?? 6), e = +(o.beyond ?? 5), [x0, y0, x1, y1] = b;
      b = o.end === 'top' ? [x0, y0 - e, x1, Math.min(y1, y0 + d)] : o.end === 'bottom' ? [x0, Math.max(y0, y1 - d), x1, y1 + e]
        : o.end === 'left' ? [x0 - e, y0, Math.min(x1, x0 + d), y1] : o.end === 'right' ? [Math.max(x0, x1 - d), y0, x1 + e, y1] : null;
      if (!b) return null;
      b = [Math.max(0, b[0]), Math.max(0, b[1]), Math.min(S.board.w, b[2]), Math.min(S.board.h, b[3])];
    }
    return [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]].map(q => q.map(v => +v.toFixed(3)));
  }
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
    else if (o.ref) {   // around a part (+ margin) or one end of it (the antenna end of a module) — follows the part when it moves
      const c = Model.comp(o.ref); if (!c || !c.pcb) throw new Error(`${o.ref} is not on the PCB`);
      if (o.end && !['top', 'bottom', 'left', 'right'].includes(o.end)) throw new Error('end must be top, bottom, left or right (board view: y grows downwards)');
      pts = refKeepoutPts(o);
    } else throw new Error('Give points (polygon), rect [x0, y0, x1, y1], circle {x, y, r} or ref (board mm)');
    if (pts.some(q => !q.every(isFinite))) throw new Error('Coordinates must be numbers (mm)');
    const L = String(o.layer || 'both').toLowerCase(), layer = /^(b|bot|bottom)$/.test(L) ? 'B' : /^(f|t|top|front)$/.test(L) ? 'F' : 'both';
    const k = { name: String(o.name || 'Keep-out ' + (keepouts().length + 1)).slice(0, 60), layer, pts, tracks: o.tracks !== false, vias: o.vias !== false, pours: o.pours !== false, parts: !!o.parts };
    if (o.ref && !o.points && !o.rect && !o.circle) Object.assign(k, { ref: Model.comp(o.ref).ref }, o.end ? { end: o.end, depth: +(o.depth ?? 6), beyond: +(o.beyond ?? 5) } : {}, o.margin ? { margin: +o.margin } : {});
    S.pcb.keepouts = ((S.pcb && S.pcb.keepouts) || []).concat([k]);
    // what is inside already (the router avoids it from now on; DRC reports it)
    const inside = drc().violations.filter(v => v.type === 'keepout' && v.msg.includes(`"${k.name}"`)).map(v => v.msg).slice(0, 20);
    return { index: S.pcb.keepouts.length - 1, keepout: k, already_inside: inside, note: inside.length ? 'Copper or parts are inside — re-route (route_pcb) or move them' : undefined };
  }
  function removeKeepout(o = {}) {
    const S = Model.S, K = (S.pcb && S.pcb.keepouts) || [], n = K.length;
    S.pcb.keepouts = K.filter((k, i) => !(o.index != null ? i === +o.index : o.name ? k.name === o.name : o.all));
    if (S.pcb.keepouts.length === n) throw new Error('Give index, name or all: true');
    return { removed: n - S.pcb.keepouts.length };
  }

  // Raster of one pour: cells inside the pour and the board, away from other nets' copper. Labels = connected islands.
  // Islands that touch no copper of the pour's net (dead copper) or are smaller than the rule pourMinArea are dropped:
  // label 0 like blocked cells. (The Gerber and the views draw the finer outlines of pourFill.)
  const pourMemo = new Map(); let pourCells = 0;
  function pourRaster(pr, gStep = 0.2) {
    const S0 = Model.S, key = JSON.stringify([pr, gStep, S0.board, S0.rules, S0.nets[pr.net], S0.pcb.traces, S0.pcb.vias, S0.pcb.holes, S0.pcb.keepouts, placed().map(c => [c.ref, c.footprint, c.pcb.x, c.pcb.y, c.pcb.rot, c.pcb.side])]);
    if (pourMemo.has(key)) return pourMemo.get(key);
    const r = pourRasterI(pr, gStep);
    // cache bounded by size too: fine rasters (EasyEDA fills at 0.05 / 0.1 mm) are big, several jobs share one machine
    pourMemo.set(key, r); pourCells += r.W * r.H;
    while (pourMemo.size > 1 && (pourMemo.size > 48 || pourCells > 12e6)) { const [k0, r0] = pourMemo.entries().next().value; pourMemo.delete(k0); pourCells -= r0.W * r0.H; }
    return r;
  }
  function pourRasterI(pr, gStep) {
    const S = Model.S, R = rules(), cl = pourCl(R, pr) + (+pr._margin || 0), poly = pourPoly(pr), bpoly = boardPoly(), idx = Model.pinIndex();
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
    for (let i = 0; i < bpoly.length; i++) block({ k: 'seg', a: bpoly[i], b: bpoly[(i + 1) % bpoly.length], r: 0 }, R.edgeClearance + (+pr._margin || 0));
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
    const minCells = (R.pourMinArea || 0) / (gStep * gStep), drop = new Uint8Array(n + 1);
    let kept = 0, deadArea = 0;
    for (let k = 1; k <= n; k++) { if (!live[k] || size[k] < minCells) drop[k] = 1; else kept++; }
    if (kept < n) for (let i = 0; i < N; i++) if (label[i] && drop[label[i]]) { label[i] = 0; deadArea++; }
    // relabel the kept islands 1…kept
    if (kept < n) { const nl = new Int32Array(n + 1); let m = 0; for (let k = 1; k <= n; k++) if (!drop[k]) nl[k] = ++m; for (let i = 0; i < N; i++) if (label[i]) label[i] = nl[label[i]]; }
    return { W, H, g: gStep, label, islands: kept, removed: n - kept, removedArea: +(deadArea * gStep * gStep).toFixed(2), at: at0 };
  }
  // each piece of a pour with its area and the pads it touches (connectivity says which pieces are joined)
  function pourIslands(pr) {
    const r = pourRaster(pr), idx = Model.pinIndex(), out = [];
    for (let k = 1; k <= r.islands; k++) out.push({ island: k, area_mm2: 0, pads: [], vias: 0 });
    for (let i = 0; i < r.label.length; i++) if (r.label[i]) out[r.label[i] - 1].area_mm2 += r.g * r.g;
    for (const c of placed()) for (const p of padsOf(c, idx)) if (p.net === pr.net && padCu(p, ['F', 'B']).includes(pr.layer)) {
      const labs = new Set([[0, 0], [0.4, 0], [-0.4, 0], [0, 0.4], [0, -0.4]].map(([a, b]) => r.at(p.x + a * p.w, p.y + b * p.h)).filter(Boolean));
      for (const l of labs) out[l - 1].pads.push(p.key);
    }
    for (const v of Model.S.pcb.vias) if (v.net === pr.net) { const l = r.at(v.x, v.y); if (l) out[l - 1].vias++; }
    for (const o of out) o.area_mm2 = +o.area_mm2.toFixed(1);
    return out;
  }
  // Stitching vias between a net's top and bottom pours: on a grid (max_spacing mm) wherever both pours are solid, plus one
  // in every piece of either pour that has none yet — so pads cut off on one side reach the other side's pour.
  function stitchPour(o = {}) {
    const S = Model.S, R = rules(), net = o.net || 'GND', P = (S.pcb.pours || []).filter(p => p.net === net);
    if (R.layers === 1) throw new Error('The board has 1 copper layer — no vias');
    const F = P.find(p => p.layer === 'F'), B = P.find(p => p.layer === 'B');
    if (!F || !B) throw new Error(`Net ${net} needs a copper pour on both layers (add_copper_pour {net: "${net}", layer: "both"})`);
    const rF = pourRaster(F), rB = pourRaster(B), d = +(o.diameter || R.viaDiameter), drill = +(o.drill || R.viaDrill), step = Math.max(1, +(o.max_spacing || 3));
    const placedV = [], near = (x, y, m) => placedV.some(v => Math.hypot(v.x - x, v.y - y) < m) || S.pcb.vias.some(v => Math.hypot(v.x - x, v.y - y) < m);
    // the whole via (+ a little) must sit on solid pour on both layers, clear of keep-outs and SMD pads
    const fits = (x, y) => {
      const rr = d / 2 + 0.1;
      for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4, px = x + rr * Math.cos(a), py = y + rr * Math.sin(a); if (!rF.at(px, py) || !rB.at(px, py)) return false; }
      if (!rF.at(x, y) || !rB.at(x, y)) return false;
      if (keepouts().some(k => k.vias && koDist(k, x, y) < d / 2 + 0.05)) return false;
      if (near(x, y, Math.max(d + R.minHoleToHole, d + 0.3))) return false;
      return !viaPadProblem({ net, x, y, d, drill }, R);
    };
    // stitching vias are automatic: rip-up and reroute replace them
    const add = (x, y) => { const v = { net, x: +x.toFixed(3), y: +y.toFixed(3), d, drill, stitch: true }; placedV.push(v); };
    for (let y = step / 2; y < S.board.h; y += step) for (let x = step / 2; x < S.board.w; x += step) if (fits(x, y)) add(x, y);
    // every piece without a via gets one (its biggest free spot)
    let joined = 0;
    for (const [ras, other] of [[rF, rB], [rB, rF]]) {
      const has = new Set([...S.pcb.vias.filter(v => v.net === net), ...placedV].map(v => ras.at(v.x, v.y)).filter(Boolean));
      for (let k = 1; k <= ras.islands; k++) {
        if (has.has(k)) continue;
        let done = false;
        for (let i = 0; i < ras.label.length && !done; i += 2) if (ras.label[i] === k) { const x = (i % ras.W) * ras.g, y = Math.floor(i / ras.W) * ras.g; if (fits(x, y)) { add(x, y); has.add(k); joined++; done = true; } }
      }
    }
    for (const v of placedV) S.pcb.vias.push(v);
    return { net, added: placedV.length, pieces_joined: joined, max_spacing: step, note: placedV.length ? 'Run run_drc; route_pcb is not needed for the pour itself' : 'No room for stitching vias (both pours must be solid at the same spot)' };
  }
  // The filled copper of a pour as outlines: one entry per live island, each a list of closed rings (outer + holes),
  // traced around the 0.1 mm raster cells. The raster keeps an extra margin (cell corners reach 0.07 mm past a cell
  // centre), so the traced copper never comes closer to other copper or the edge than the rules. For EasyEDA exports.
  function pourFillRings(pr, g = 0.1, margin = 0.08) {
    const r = pourRaster(Object.assign({}, pr, { _margin: margin }), g), W = r.W, H = r.H, L = r.label, out = [];
    for (let k = 1; k <= r.islands; k++) {
      // directed boundary edges around the island's cells (doubled integer coordinates: cell centre 2x, corners 2x ± 1)
      const next = new Map(), key = (x, y) => x * 100003 + y;
      const edge = (x0, y0, x1, y1) => { const kk = key(x0, y0); let a = next.get(kk); if (!a) next.set(kk, a = []); a.push([x0, y0, x1, y1]); };
      const isK = (x, y) => x >= 0 && y >= 0 && x < W && y < H && L[y * W + x] === k;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (L[y * W + x] !== k) continue;
        const X0 = 2 * x - 1, X1 = 2 * x + 1, Y0 = 2 * y - 1, Y1 = 2 * y + 1;
        if (!isK(x, y - 1)) edge(X0, Y0, X1, Y0);
        if (!isK(x + 1, y)) edge(X1, Y0, X1, Y1);
        if (!isK(x, y + 1)) edge(X1, Y1, X0, Y1);
        if (!isK(x - 1, y)) edge(X0, Y1, X0, Y0);
      }
      const rings = [];
      for (const [, list] of next) while (list.length) {
        const e0 = list.pop(), ring = [[e0[0], e0[1]]];
        let cx = e0[2], cy = e0[3], guard = 0;
        while (!(cx === e0[0] && cy === e0[1]) && guard++ < 4e6) {
          ring.push([cx, cy]);
          const a = next.get(key(cx, cy)); if (!a || !a.length) break;
          const e = a.pop(); cx = e[2]; cy = e[3];
        }
        // drop the corners in the middle of straight runs
        const pts = ring.filter((q, i) => { const p0 = ring[(i - 1 + ring.length) % ring.length], p1 = ring[(i + 1) % ring.length]; return (q[0] - p0[0]) * (p1[1] - q[1]) !== (q[1] - p0[1]) * (p1[0] - q[0]); });
        if (pts.length >= 3) rings.push(pts.map(q => [+(q[0] * g / 2).toFixed(4), +(q[1] * g / 2).toFixed(4)]));
      }
      if (rings.length) out.push(rings);
    }
    return out;
  }
  const pourInfo = pr => { try { const r = pourRaster(pr); return { islands: r.islands, removed: r.removed, removed_mm2: r.removedArea }; } catch (e) { return {}; } };
  // pour templates: the project's pour recipe, re-applied after re-routing / outline changes (reroute does it by itself)
  function savePourTemplate() { const S = Model.S; S.pcb.pourTemplate = JSON.parse(JSON.stringify(S.pcb.pours || [])); return { saved: S.pcb.pourTemplate.length, pours: S.pcb.pourTemplate.map(describePour) }; }
  function applyPourTemplate() {
    const S = Model.S, T = S.pcb.pourTemplate; if (!T || !T.length) throw new Error('No pour template saved — add the pours, then save_pour_template');
    S.pcb.pours = JSON.parse(JSON.stringify(T)).filter(p => S.nets[p.net]);
    return { applied: S.pcb.pours.length, pours: S.pcb.pours.map(describePour) };
  }
  const describePour = p => `${p.net} ${p.layer === 'B' ? 'bottom' : 'top'} ${p.pts ? p.pts.length + '-corner area' : 'whole board'}${p.clip ? ' clipped ' + Object.entries(p.clip).map(([k, v]) => `${k.replace('_', ' ')} ${v}`).join(', ') : ''}`;
  // The live copper of a pour as outlines, for the Gerber and the board / 3D views. A distance field — other nets' copper
  // minus the clearance, the board edge minus the edge clearance, the pour outline, keep-outs — is sampled on a fine
  // grid; pieces with no copper of the pour's own net (or under pourMinArea) are dropped, and every live piece is
  // traced (marching squares) δ outside its true edge, i.e. inside the clearance band. The caller then clears that band
  // with the exact copper shapes, so all edges are exact, and nothing outside a live piece is ever drawn: no slivers of
  // dead copper ("scrap copper") between tracks or along them. Rings come sorted by nesting depth: even = copper, odd = hole.
  const fillMemo = new Map();
  function pourFill(pr, gStep) {
    const S = Model.S, R = rules(), cl = pourCl(R, pr), A = S.board.w * S.board.h;
    // Gerber: ≥ 0.05 mm (finer on small boards); 'view' (board / 3D view, redrawn while parts move): 0.1 – 0.2 mm by board size
    const g = gStep === 'view' ? (A <= 1000 ? 0.1 : A <= 3000 ? 0.15 : 0.2) : gStep || Math.max(0.05, Math.ceil(Math.sqrt(A / 2.5e6) * 100) / 100);
    const key = JSON.stringify([pr, g, S.board, S.rules, S.nets[pr.net], S.pcb.traces, S.pcb.vias, S.pcb.holes, S.pcb.keepouts, placed().map(c => [c.ref, c.footprint, c.pcb.x, c.pcb.y, c.pcb.rot, c.pcb.side])]);
    if (fillMemo.has(key)) return fillMemo.get(key);
    const r = pourFillI(pr, g, cl, R);
    fillMemo.set(key, r); while (fillMemo.size > 8) fillMemo.delete(fillMemo.keys().next().value);
    return r;
  }
  function pourFillI(pr, g, cl, R) {
    const S = Model.S, idx = Model.pinIndex(), L2 = R.layers === 1 ? ['F'] : ['F', 'B'];
    const { sqrt, abs, min, max, floor, ceil } = Math;   // local: global lookups are slow in the tool server's sandbox
    const dl = min(1.2 * g, 0.6 * cl), M = dl + 2 * g;   // δ, and how far the field is resolved
    // the grid covers the pour's own area (a panel has many small pours); sample (x, y) sits at ((x + X0) g, (y + Y0) g)
    const pp = pourPoly(pr); let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity; for (const [x, y] of pp) { bx0 = min(bx0, x); by0 = min(by0, y); bx1 = max(bx1, x); by1 = max(by1, y); }
    const X0 = max(0, floor((bx0 - M) / g)), Y0 = max(0, floor((by0 - M) / g)), X1 = min(ceil(S.board.w / g), ceil((bx1 + M) / g)), Y1 = min(ceil(S.board.h / g), ceil((by1 + M) / g));
    const W = max(1, X1 - X0 + 1), H = max(1, Y1 - Y0 + 1), N = W * H, f = new Float32Array(N).fill(M);
    // signed distance to a shape (negative inside)
    const sd = (s, x, y) => {
      if (s.k === 'circ') { const dx = x - s.c[0], dy = y - s.c[1]; return sqrt(dx * dx + dy * dy) - s.r; }
      if (s.k === 'rect') { const dx = abs(x - s.cx) - s.hw, dy = abs(y - s.cy) - s.hh; if (dx <= 0 && dy <= 0) return dx > dy ? dx : dy; const ex = dx > 0 ? dx : 0, ey = dy > 0 ? dy : 0; return sqrt(ex * ex + ey * ey); }
      const vx = s.b[0] - s.a[0], vy = s.b[1] - s.a[1], l2 = vx * vx + vy * vy; let t = l2 ? ((x - s.a[0]) * vx + (y - s.a[1]) * vy) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = x - s.a[0] - t * vx, ey = y - s.a[1] - t * vy; return sqrt(ex * ex + ey * ey) - s.r;
    };
    const span = (b, m) => [max(0, floor((b[0] - m) / g) - X0), max(0, floor((b[1] - m) / g) - Y0), min(W - 1, ceil((b[2] + m) / g) - X0), min(H - 1, ceil((b[3] + m) / g) - Y0)];
    // a rectangular pad is cleared as the Gerber does it: the pad aperture grown by 2 cl (square corners)
    const obstacle = (s, c) => { if (s.k === 'rect') { s = { k: 'rect', cx: s.cx, cy: s.cy, hw: s.hw + c, hh: s.hh + c }; c = 0; } const [x0, y0, x1, y1] = span(bboxOf(s), c + M); for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const i = y * W + x, v = sd(s, (x + X0) * g, (y + Y0) * g) - c; if (v < f[i]) f[i] = v; } };
    // polygon term: sign · (signed distance, positive inside) − off; resolved within M of the outline, ±M elsewhere
    const polyTerm = (pl, off, sign) => {
      const ins = new Uint8Array(N), dm = new Float32Array(N).fill(M + abs(off));
      for (let y = 0; y < H; y++) { const py = (y + Y0) * g, xs = []; for (let i = 0, j = pl.length - 1; i < pl.length; j = i++) { const [xi, yi] = pl[i], [xj, yj] = pl[j]; if ((yi > py) !== (yj > py)) xs.push((xj - xi) * (py - yi) / (yj - yi) + xi); } xs.sort((a, b) => a - b); for (let k = 0; k + 1 < xs.length; k += 2) { const xe = min(W - 1, floor(xs[k + 1] / g) - X0); for (let x = max(0, ceil(xs[k] / g) - X0); x <= xe; x++) ins[y * W + x] = 1; } }
      for (let e = 0; e < pl.length; e++) { const s = { k: 'seg', a: pl[e], b: pl[(e + 1) % pl.length], r: 0 }, [x0, y0, x1, y1] = span(bboxOf(s), M + abs(off)); for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const i = y * W + x, d = sd(s, (x + X0) * g, (y + Y0) * g); if (d < dm[i]) dm[i] = d; } }
      for (let i = 0; i < N; i++) { const v = sign * ((ins[i] ? dm[i] : -dm[i]) - off); if (v < f[i]) f[i] = v; }
    };
    polyTerm(boardPoly(), R.edgeClearance, 1);
    polyTerm(pp, -dl, 1);   // the trace lands on the pour outline itself
    for (const k of keepouts()) if (k.pours && koOn(k, pr.layer)) polyTerm(k.pts, 0, -1);
    for (const c of placed()) for (const q of padsOf(c, idx)) if (q.net !== pr.net && padCu(q, L2).includes(pr.layer)) obstacle(padShape(q), cl);
    for (const t of S.pcb.traces) if (t.net !== pr.net && t.layer === pr.layer) for (let i = 1; i < t.pts.length; i++) obstacle({ k: 'seg', a: t.pts[i - 1], b: t.pts[i], r: t.w / 2 }, cl);
    for (const v of S.pcb.vias) if (v.net !== pr.net) obstacle({ k: 'circ', c: [v.x, v.y], r: v.d / 2 }, cl);
    for (const h of S.pcb.holes || []) obstacle({ k: 'circ', c: [h.x, h.y], r: h.d / 2 }, cl);
    // pieces: samples with f > τ (τ > g/2: the free disks of two neighbours overlap, so the copper between them is
    // really there), 4-connected; the thinner rim (0 < f ≤ τ) joins the one piece next to it, or -1 when it touches
    // none or two (a hairline the grid cannot resolve: never drawn). Then: which pieces touch copper of the pour's net
    const tau = 0.55 * g, label = new Int32Array(N), size = [0]; let n = 0;
    for (let i = 0; i < N; i++) if (f[i] > tau && !label[i]) {
      n++; const st = [i]; label[i] = n; size[n] = 0;
      const go = j => { if (f[j] > tau && !label[j]) { label[j] = n; st.push(j); } };
      while (st.length) { const k = st.pop(), x = k % W; size[n]++; if (x + 1 < W) go(k + 1); if (x > 0) go(k - 1); if (k + W < N) go(k + W); if (k >= W) go(k - W); }
    }
    const nb8 = (i, fn) => { const x = i % W, y = (i / W) | 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { if (!dx && !dy) continue; const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < W && ny < H) fn(ny * W + nx); } };
    for (let i = 0; i < N; i++) if (f[i] > 0 && f[i] <= tau) {
      let one = 0; nb8(i, j => { const m = label[j]; if (m > 0 && f[j] > tau) one = one === 0 || one === m ? m : -1; });
      label[i] = one || -1; if (one > 0) size[one]++;
    }
    const live = new Uint8Array(n + 1);
    const touch = s => { const [x0, y0, x1, y1] = span(bboxOf(s), g); for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const i = y * W + x; if (label[i] > 0 && f[i] > tau && sd(s, (x + X0) * g, (y + Y0) * g) < f[i]) live[label[i]] = 1; } };   // a solid sample whose free disk reaches the copper (a hairline is no connection)
    const own = [];
    for (const c of placed()) for (const q of padsOf(c, idx)) if (q.net === pr.net && padCu(q, L2).includes(pr.layer)) own.push(padShape(q));
    for (const t of S.pcb.traces) if (t.net === pr.net && t.layer === pr.layer) for (let i = 1; i < t.pts.length; i++) own.push({ k: 'seg', a: t.pts[i - 1], b: t.pts[i], r: t.w / 2 });
    for (const v of S.pcb.vias) if (v.net === pr.net) own.push({ k: 'circ', c: [v.x, v.y], r: v.d / 2 });
    for (const s of own) touch(s);
    const minCells = (R.pourMinArea || 0) / (g * g);
    for (let k = 1; k <= n; k++) if (size[k] < minCells) live[k] = 0;
    // traced field (padded by one sample of -1): live samples f + δ; samples next to a live one and to nothing dead or
    // unresolved f + δ (the band δ wide outside the piece); everything else -1, so a dead piece is never drawn
    const Wp = W + 2, Hp = H + 2, v = new Float32Array(Wp * Hp).fill(-1);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, l = label[i]; let val = -1;
      if (l > 0) { if (live[l]) val = f[i] + dl; }
      else if (l === 0) {
        let nl = false, nd = false;
        nb8(i, j => { const m = label[j]; if (m > 0 && live[m]) nl = true; else if (m) nd = true; });
        if (nl && !nd) val = f[i] + dl;   // the true value, so the crossing lands where the field says
      }
      v[(y + 1) * Wp + x + 1] = val;
    }
    // the outline always runs into the net's own pads / tracks / vias (drawn on top anyway): no micro-gap where a piece meets them
    for (const s of own) { const [x0, y0, x1, y1] = span(bboxOf(s), 0); for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const j = (y + 1) * Wp + x + 1; if (v[j] < 0.5 * g && sd(s, (x + X0) * g, (y + Y0) * g) <= 0) v[j] = 0.5 * g; } }
    // marching squares: one crossing point per grid edge, two segments meet at each point; saddles follow the cell centre
    const pt = new Map(), adj = new Map(), PX = i => (i - 1 + X0) * g, PY = i => (i - 1 + Y0) * g;
    const edgePt = (id) => { if (pt.has(id)) return pt.get(id); const h = id % 2 === 0, c = id >> 1, x = c % Wp, y = (c / Wp) | 0, a = v[c], b = h ? v[c + 1] : v[c + Wp], t = a / (a - b), p = h ? [PX(x) + t * g, PY(y)] : [PX(x), PY(y) + t * g]; pt.set(id, p); return p; };
    const link = (a, b) => { for (const [p, q] of [[a, b], [b, a]]) { const l = adj.get(p); if (l) l.push(q); else adj.set(p, [q]); } };
    for (let y = 0; y + 1 < Hp; y++) for (let x = 0; x + 1 < Wp; x++) {
      const c = y * Wp + x, a = v[c] > 0, b = v[c + 1] > 0, cc = v[c + Wp + 1] > 0, d = v[c + Wp] > 0;
      if (a === b && b === cc && cc === d) continue;
      const T = 2 * c, Rr = 2 * (c + 1) + 1, B = 2 * (c + Wp), Lf = 2 * c + 1;   // top, right, bottom, left edge ids
      const cut = [[Lf, T], [T, Rr], [Rr, B], [B, Lf]], s = [a, b, cc, d];
      if (a === cc && b === d) {   // saddle: cut off the corners whose sign differs from the centre
        const ctr = (v[c] + v[c + 1] + v[c + Wp + 1] + v[c + Wp]) / 4 > 0;
        for (let k = 0; k < 4; k++) if (s[k] !== ctr) link(...cut[k]);
      } else {
        const e = []; if (a !== b) e.push(T); if (b !== cc) e.push(Rr); if (cc !== d) e.push(B); if (d !== a) e.push(Lf);
        link(e[0], e[1]);
      }
    }
    // rings, simplified (Douglas–Peucker, well under δ)
    const eps = Math.min(0.01, dl / 4), rings = [];
    const simplify = P => {
      const keep = new Uint8Array(P.length); keep[0] = keep[P.length - 1] = 1; const st = [[0, P.length - 1]];
      while (st.length) { const [i0, i1] = st.pop(); let dm = 0, im = -1; const [ax, ay] = P[i0], [bx, by] = P[i1], vx = bx - ax, vy = by - ay, l = Math.hypot(vx, vy) || 1e-9;
        for (let i = i0 + 1; i < i1; i++) { const dd = abs((P[i][0] - ax) * vy - (P[i][1] - ay) * vx) / l; if (dd > dm) { dm = dd; im = i; } }
        if (dm > eps) { keep[im] = 1; st.push([i0, im], [im, i1]); } }
      return P.filter((q, i) => keep[i]);
    };
    const seen = new Set();
    for (const s0 of adj.keys()) {
      if (seen.has(s0)) continue;
      const ids = [s0]; seen.add(s0); let prev = -1, cur = s0;
      for (;;) { const nx = adj.get(cur).find(q => q !== prev && !seen.has(q)); if (nx == null) break; seen.add(nx); ids.push(nx); prev = cur; cur = nx; }
      if (ids.length < 3) continue;
      const P = ids.map(edgePt); P.push(P[0]);
      // split the closed ring at its farthest point so both halves simplify cleanly
      let far = 0, fd = 0; for (let i = 1; i < P.length - 1; i++) { const dd = (P[i][0] - P[0][0]) ** 2 + (P[i][1] - P[0][1]) ** 2; if (dd > fd) { fd = dd; far = i; } }
      const pts = simplify(P.slice(0, far + 1)).concat(simplify(P.slice(far)).slice(1, -1)).map(q => [+q[0].toFixed(4), +q[1].toFixed(4)]);
      if (pts.length < 3) continue;
      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity; for (const [x, y] of pts) { bx0 = min(bx0, x); by0 = min(by0, y); bx1 = max(bx1, x); by1 = max(by1, y); }
      rings.push({ pts, box: [bx0, by0, bx1, by1] });
    }
    // nesting depth: how many other rings hold a point of this one (contours never cross)
    for (const rg of rings) { const [x, y] = rg.pts[0]; rg.depth = 0; for (const o of rings) if (o !== rg && x >= o.box[0] && x <= o.box[2] && y >= o.box[1] && y <= o.box[3] && inPoly(x, y, o.pts)) rg.depth++; }
    rings.sort((a, b) => a.depth - b.depth);
    let pieces = 0, dropped = 0; for (let k = 1; k <= n; k++) live[k] ? pieces++ : dropped++;
    return { g, rings: rings.map(rg => ({ pts: rg.pts, hole: rg.depth % 2 === 1 })), pieces, dropped };
  }
  function addPour(o = {}) {
    const S = Model.S; if (!S.board.w) throw new Error('Generate the PCB first');
    const net = o.net || 'GND'; if (!S.nets[net]) throw new Error(`No net "${net}"`);
    const layers = o.layer === 'both' ? ['F', 'B'] : [o.layer === 'B' || o.layer === 'bottom' ? 'B' : 'F'];
    S.pcb.pours = S.pcb.pours || [];
    const added = [];
    for (const layer of layers) {
      const pr = { net, layer };
      if (o.points && o.points.length >= 3) pr.pts = o.points.map(q => [+q[0], +q[1]]);
      else if (Array.isArray(o.rect) && o.rect.length === 4) { const [x0, y0, x1, y1] = o.rect.map(Number); pr.whole = true; pr.clip = { x_min: Math.min(x0, x1), x_max: Math.max(x0, x1), y_min: Math.min(y0, y1), y_max: Math.max(y0, y1) }; }
      else pr.whole = true;
      // clip: the board outline cut at x / y limits — follows later outline changes
      if (o.clip && typeof o.clip === 'object' && !pr.pts) { pr.clip = Object.assign({}, pr.clip || {}); for (const k of ['x_min', 'x_max', 'y_min', 'y_max']) if (o.clip[k] != null) pr.clip[k] = +o.clip[k]; }
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
    // locked parts stay exactly where they are; everything else is arranged around them
    const lockedSet = new Set(cs.filter(c => c.pcb && c.pcb.locked));
    for (const c of cs) { if (lockedSet.has(c)) continue; const side = c.pcb && c.pcb.side; c.pcb = { x: 0, y: 0, rot: c.rot || 0 }; if (side === 'B') c.pcb.side = 'B'; }
    // 1) keep the schematic arrangement, scaled to fit the board
    const xs = cs.map(c => c.x), ys = cs.map(c => c.y), sxm = (Math.min(...xs) + Math.max(...xs)) / 2, sym = (Math.min(...ys) + Math.max(...ys)) / 2;
    const spanX = Math.max(1, Math.max(...xs) - Math.min(...xs)), spanY = Math.max(1, Math.max(...ys) - Math.min(...ys));
    const k = Math.min(0.12, (W - 2 * margin) * 0.7 / spanX, (H - 2 * margin) * 0.7 / spanY);
    for (const c of cs) if (!lockedSet.has(c)) { c.pcb.x = cx0 + (c.x - sxm) * k; c.pcb.y = cy0 + (c.y - sym) * k; }
    // 2) connectors on the board edges (plugs flush, headers just inside), slid inward on curved outlines
    const edgeParts = [], lock = new Map();
    for (const c of cs) {
      const info = edgeInfo(c); if ((!info && !c.pcbEdge) || lockedSet.has(c)) continue;
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
    const free = cs.filter(c => !lock.has(c) && !lockedSet.has(c));
    // 2b) arrange for routability: anneal on wire length with fan-out room around each part, then legalise around it
    // several annealing runs from the same start (different seeds); the lowest-cost arrangement wins
    if (opt.anneal !== false) {
      const fx = new Set([...edgeParts.map(e => e.c.ref), ...[...lockedSet].map(c => c.ref)]), tries = Math.max(1, opt.tries ?? 3), base = cs.map(c => JSON.parse(JSON.stringify(c.pcb)));
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
      const placed = [...lockedSet], failed = [];
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
    const res = { board: boardBrief(), kept_board: true, placed: cs.length, fits: !still.length && !outside.length, parts_area_pct: Math.round(area / boardArea * 100), on_edge: edgeParts.map(e => `${e.c.ref}:${e.side}${e.plug ? ' (opening outward)' : ''}`) };
    if (!res.fits) { res.overlapping = still; res.outside = outside; res.hint = `The parts need about ${Math.round(area / boardArea * 100)}% of the board area — enlarge the board (Board W×H, or clear it for auto-size), move parts to the bottom side, or use smaller packages.`; }
    return res;
  }
  function boxInside(c, poly, inset) {
    const b = fpBox(c, inset);
    if (!isRectBoard()) return bodyPoints(c, inset).every(q => inPoly(q[0], q[1], poly));
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
    const own = new Set(cs.map(c => c.ref)), gap = Math.max(o.gap != null ? +o.gap : 0.5, +R.partGap || 0), margin = Math.max(R.edgeClearance + 0.2, 0.5), poly = boardPoly();
    const fixed = placed().filter(c => !own.has(c.ref)).map(c => ({ b: fpBox(c, gap / 2), side: isBottom(c) ? 'B' : 'F', th: thBoxes(c, gap) }));
    const holes = (S.pcb.holes || []).map(h => [h.x - h.d / 2 - gap, h.y - h.d / 2 - gap, h.x + h.d / 2 + gap, h.y + h.d / 2 + gap]);
    // every keep-out by default (a part brings copper pads); allow_keepouts: only those that forbid parts
    const kos = keepouts().filter(k => k.parts || (o.allow_keepouts !== true && (k.tracks || k.pours)));
    const reg = Array.isArray(o.region) && o.region.length === 4 ? [Math.min(o.region[0], o.region[2]), Math.min(o.region[1], o.region[3]), Math.max(o.region[0], o.region[2]), Math.max(o.region[1], o.region[3])].map(Number) : null;
    const hitBox = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
    // SMD parts on opposite sides may overlap; through-hole parts block both sides
    const free = c => {
      if (!boxInside(c, poly, margin)) return false;
      if (reg) { const b = fpBox(c); if (b[0] < reg[0] || b[1] < reg[1] || b[2] > reg[2] || b[3] > reg[3]) return false; }
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
      // the parts they connect to: signal nets, else supply nets other than ground (a decoupling cap goes next to its IC's supply pin)
      const idx = Model.pinIndex(), nets = new Set(), sup = new Set();
      for (const c of cs) for (const p of padsOf(c, idx)) if (p.net) { if (!Model.isPower(p.net)) nets.add(p.net); else if (!Model.isGround(p.net)) sup.add(p.net); }
      if (!nets.size) for (const n of sup) nets.add(n);
      const pts = []; for (const c of placed()) if (!own.has(c.ref)) for (const p of padsOf(c, idx)) if (nets.has(p.net)) pts.push([p.x, p.y]);
      T = pts.length ? [pts.reduce((a, q) => a + q[0], 0) / pts.length, pts.reduce((a, q) => a + q[1], 0) / pts.length] : reg ? [(reg[0] + reg[2]) / 2, (reg[1] + reg[3]) / 2] : [S.board.w / 2, S.board.h / 2];
    }
    const step = +o.step || 0.25, grid = [];
    for (let y = 0; y <= S.board.h; y += step) for (let x = 0; x <= S.board.w; x += step) grid.push([x, y]);
    const near = t => grid.map(q => [q[0], q[1], Math.hypot(q[0] - t[0], q[1] - t[1])]).sort((a, b) => a[2] - b[2]);
    const cand = near(T);
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
    const failed = [], kept = [], idx2 = Model.pinIndex();
    // each part heads for what it connects to (signal nets first, else its supply pin), not for the middle of the whole
    // list: a block's parts stay next to their own IC instead of being scattered
    const targetFor = c => {
      if (o.near) return T;
      const sig = new Set(), sup = new Set();
      for (const p of padsOf(c, idx2)) if (p.net) { if (!Model.isPower(p.net)) sig.add(p.net); else if (!Model.isGround(p.net)) sup.add(p.net); }
      const nets = sig.size ? sig : sup, pts = [];
      for (const q of placed()) if (q !== c && (!own.has(q.ref) || placedNow.has(q.ref))) for (const p of padsOf(q, idx2)) if (nets.has(p.net)) pts.push([p.x, p.y]);
      return pts.length ? [pts.reduce((a, q) => a + q[0], 0) / pts.length, pts.reduce((a, q) => a + q[1], 0) / pts.length] : T;
    };
    const placedNow = new Set();
    // bigger parts first (the small ones fit around them); with only_overlapping (default) a part already clear of
    // everything stays where it is
    const order = cs.slice().sort((a, b) => { const A = fpBox(a), B = fpBox(b); return (B[2] - B[0]) * (B[3] - B[1]) - (A[2] - A[0]) * (A[3] - A[1]); });
    for (const c of order) {
      if (o.only_overlapping !== false && !o.near && !reg && c.pcb && free(c)) { kept.push(c.ref); placedNow.add(c.ref); fixed.push({ b: fpBox(c, gap / 2), side: isBottom(c) ? 'B' : 'F', th: thBoxes(c, gap) }); continue; }
      const x0 = c.pcb.x, y0 = c.pcb.y, r0 = c.pcb.rot || 0, rots = o.rotate === false ? [r0] : [r0, ...[0, 90, 180, 270].filter(r => r !== r0)];
      let ok = false;
      for (const [x, y] of (o.near ? cand : near(targetFor(c)))) { for (const r of rots) { c.pcb.x = +x.toFixed(3); c.pcb.y = +y.toFixed(3); c.pcb.rot = r; if (free(c)) { ok = true; break; } } if (ok) break; }
      if (!ok) { c.pcb.x = x0; c.pcb.y = y0; c.pcb.rot = r0; failed.push(c.ref); continue; }
      fixed.push({ b: fpBox(c, gap / 2), side: isBottom(c) ? 'B' : 'F', th: thBoxes(c, gap) });   // the next part avoids this one
      placedNow.add(c.ref);
      moves.push({ ref: c.ref, x: c.pcb.x, y: c.pcb.y, rot: c.pcb.rot, moved_mm: +Math.hypot(c.pcb.x - x0, c.pcb.y - y0).toFixed(2) });
    }
    return { placed: moves, kept_in_place: kept.length ? kept : undefined, failed: failed.length ? failed : undefined, note: failed.length ? 'No free spot for these — grow the board or make room' : 'Tracks to the moved parts need routing: route_pcb' };
  }
  // what a part blocks on the other side of the board: only its through-hole pins (pad box + gap), not its body
  const thBoxes = (c, gap = 0) => padsOf(c).filter(p => p.drill).map(p => [p.x - p.w / 2 - gap / 2, p.y - p.h / 2 - gap / 2, p.x + p.w / 2 + gap / 2, p.y + p.h / 2 + gap / 2]);
  // how far a part is from the board edge (negative = outside): copper (its pads) and body (its box, or circle for round pads)
  function partMargin(c, poly = boardPoly()) {
    let cu = Infinity, body = Infinity;
    for (const p of padsOf(c)) cu = Math.min(cu, edgeDist(padShape(p), poly));
    for (const q of bodyPoints(c)) body = Math.min(body, edgeDist({ k: 'circ', c: q, r: 0 }, poly));
    return { ref: c.ref, copper_mm: +(isFinite(cu) ? cu : body).toFixed(2), body_mm: +body.toFixed(2) };
  }
  // the parts closest to the edge (or all), smallest margin first
  function edgeMargins(o = {}) {
    const R = rules(), poly = boardPoly(), list = placed().filter(c => !o.refs || o.refs.includes(c.ref)).map(c => partMargin(c, poly)).sort((a, b) => a.copper_mm - b.copper_mm);
    const tight = list.filter(m => m.copper_mm < R.edgeClearance || m.body_mm < 0);
    return { edge_rule_mm: R.edgeClearance, too_close: tight, closest: o.all ? list : list.slice(0, 8) };
  }
  // nudge parts whose copper is closer than the edge rule (+ 0.1 mm) or whose body sticks out, towards the board centre
  function autoFit(refs) {
    const R = rules(), poly = boardPoly(), S = Model.S, cx = S.board.w / 2, cy = S.board.h / 2, moved = [];
    for (const c of placed()) {
      if ((refs && !refs.includes(c.ref)) || c.pcb.locked || c.pcbEdge) continue;
      let m = partMargin(c, poly); if (m.copper_mm >= R.edgeClearance + 0.1 && m.body_mm >= 0) continue;
      const x0 = c.pcb.x, y0 = c.pcb.y, dx = cx - c.pcb.x, dy = cy - c.pcb.y, l = Math.hypot(dx, dy) || 1;
      for (let t = 1; t <= 60 && (m.copper_mm < R.edgeClearance + 0.1 || m.body_mm < 0); t++) { c.pcb.x = +(x0 + dx / l * 0.05 * t).toFixed(3); c.pcb.y = +(y0 + dy / l * 0.05 * t).toFixed(3); m = partMargin(c, poly); }
      moved.push({ ref: c.ref, moved_mm: +Math.hypot(c.pcb.x - x0, c.pcb.y - y0).toFixed(2), copper_mm: m.copper_mm });
    }
    return moved;
  }
  // Move (dx, dy), rotate the group or scale its spacing (about its centre): parts by refs or everything in a region.
  // Tracks between moved parts move with them; tracks to parts that stay are removed (route again). Returns edge margins.
  function transformParts(o = {}) {
    const S = Model.S;
    let cs = placed();
    if (o.refs && o.refs.length) { const want = new Set(o.refs); cs = cs.filter(c => want.has(c.ref)); const miss = o.refs.filter(r => !cs.some(c => c.ref === r)); if (miss.length) throw new Error('Not on the PCB: ' + miss.join(', ')); }
    else if (o.region) { const [x0, y0, x1, y1] = o.region.map(Number); cs = cs.filter(c => c.pcb.x >= Math.min(x0, x1) && c.pcb.x <= Math.max(x0, x1) && c.pcb.y >= Math.min(y0, y1) && c.pcb.y <= Math.max(y0, y1)); }
    else if (!o.all) throw new Error('Give refs, region [x0, y0, x1, y1] or all: true');
    if (!cs.length) throw new Error('No parts selected');
    const locked = cs.filter(c => c.pcb.locked && !o.include_locked); if (locked.length) cs = cs.filter(c => !locked.includes(c));
    const dx = +o.dx || 0, dy = +o.dy || 0, k = o.scale != null ? +o.scale : 1, rot = ((+o.rotate || 0) % 360 + 360) % 360;
    if (rot % 90) throw new Error('rotate must be a multiple of 90');
    const ox = o.origin ? +o.origin[0] : cs.reduce((a, c) => a + c.pcb.x, 0) / cs.length, oy = o.origin ? +o.origin[1] : cs.reduce((a, c) => a + c.pcb.y, 0) / cs.length;
    const T = (x, y) => { let u = (x - ox) * k, v = (y - oy) * k; for (let r = 0; r < rot; r += 90) { const t = u; u = -v; v = t; } return [+(ox + u + dx).toFixed(4), +(oy + v + dy).toFixed(4)]; };
    // tracks: both ends on moved parts → move along; one end → removed
    const idx = Model.pinIndex(), own = new Set(cs.map(c => c.ref)), pads = cs.flatMap(c => padsOf(c, idx)), others = placed().filter(c => !own.has(c.ref)).flatMap(c => padsOf(c, idx));
    const onMoved = q => pads.some(p => padDist(p, q[0], q[1]) <= 1e-3), onOther = q => others.some(p => padDist(p, q[0], q[1]) <= 1e-3);
    let movedT = 0, removedT = 0; const keepT = [], movedPts = new Set();
    for (const t of S.pcb.traces) {
      const a = onMoved(t.pts[0]), b = onMoved(t.pts[t.pts.length - 1]);
      if (a && b && !t.pts.some(q => onOther(q))) { t.pts = t.pts.map(q => T(q[0], q[1])); movedT++; t.pts.forEach(q => movedPts.add(q.join(','))); keepT.push(t); }
      else if ((a || b) && !t.manual) removedT++;
      else keepT.push(t);
    }
    S.pcb.traces = keepT;
    for (const v of S.pcb.vias) if (cs.some(c => { const b = fpBox(c, 0.5); return v.x > b[0] && v.x < b[2] && v.y > b[1] && v.y < b[3]; }) && !v.manual) { const [x, y] = T(v.x, v.y); v.x = x; v.y = y; }
    for (const c of cs) { const [x, y] = T(c.pcb.x, c.pcb.y); c.pcb.x = x; c.pcb.y = y; if (rot) c.pcb.rot = ((c.pcb.rot || 0) + rot) % 360; }
    const fit = o.auto_fit ? autoFit(cs.map(c => c.ref)) : undefined;
    return { moved: cs.map(c => c.ref), skipped_locked: locked.length ? locked.map(c => c.ref) : undefined, tracks_moved: movedT, tracks_removed: removedT, auto_fit: fit,
      margins: edgeMargins({ refs: cs.map(c => c.ref) }), overlaps: legalCheck(cs.map(c => c.ref)), note: removedT ? 'Tracks to parts that did not move were removed — route_pcb' : undefined };
  }
  // Fast placement check (no routing): parts overlapping (SMD parts on opposite sides may), outside the outline, in a
  // part keep-out, on a mounting hole. refs: only problems that involve these parts.
  // tol: overlaps of the footprint boxes smaller than this (mm, in either direction) are ignored — boxes include margins
  function checkPlacement(refs, gap = 0, tol = 0.25, o_ = {}) {
    const S = Model.S, R = rules(), idx = Model.pinIndex(), cs = placed(), only = refs && refs.length ? new Set(refs) : null, poly = boardPoly(), out = [], accepted = [];
    const okPairs = new Set((S.pcb.okOverlaps || []).map(p => p.slice().sort().join('|')));
    const info = cs.map(c => ({ c, b: fpBox(c, gap / 2), side: isBottom(c) ? 'B' : 'F', th: thBoxes(c, gap) }));
    const hit = (a, b) => Math.min(a[2], b[2]) - Math.max(a[0], b[0]) > tol && Math.min(a[3], b[3]) - Math.max(a[1], b[1]) > tol;
    for (let i = 0; i < info.length; i++) for (let j = i + 1; j < info.length; j++) {
      const A = info[i], B = info[j]; if (only && !only.has(A.c.ref) && !only.has(B.c.ref)) continue;
      if (!(A.side === B.side ? hit(A.b, B.b) : (A.th.some(t => hit(t, B.b)) || B.th.some(t => hit(t, A.b))))) continue;
      const key = [A.c.ref, B.c.ref].sort().join('|');
      const ox = Math.min(A.b[2], B.b[2]) - Math.max(A.b[0], B.b[0]), oy = Math.min(A.b[3], B.b[3]) - Math.max(A.b[1], B.b[1]);
      // pads: the copper that matters — courtyard-only overlaps are often fine (a module over small parts on the other side …)
      let gap = Infinity;
      const pa = padsOf(A.c, idx), pb = padsOf(B.c, idx), L2 = ['F', 'B'];
      for (const p of pa) for (const q of pb) if (padCu(p, L2).some(l => padCu(q, L2).includes(l))) gap = Math.min(gap, shapeDist(padShape(p), padShape(q)));
      const padsOk = gap >= R.clearance - 1e-3, o = { type: 'overlap', parts: [A.c.ref, B.c.ref], overlap_mm: +Math.min(ox, oy).toFixed(2), pads_gap_mm: isFinite(gap) ? +gap.toFixed(2) : null, pads_clear: padsOk,
        msg: `${A.c.ref} overlaps ${B.c.ref} by ${Math.min(ox, oy).toFixed(2)} mm${A.side !== B.side ? ' (through-hole pins on the other side)' : ''} — ${!isFinite(gap) ? 'no pads on a shared layer' : padsOk ? `courtyards only, pads ${gap.toFixed(2)} mm apart` : `PADS ${gap <= 0 ? 'TOUCH' : gap.toFixed(2) + ' mm apart'} (rule ${R.clearance})`}` };
      if (okPairs.has(key)) { if (o_.show_accepted) accepted.push(o); } else out.push(o);
    }
    for (const A of info) {
      if (only && !only.has(A.c.ref)) continue;
      if (!boxInside(A.c, poly, 0)) { const m = partMargin(A.c, poly); out.push({ type: 'outside', parts: [A.c.ref], copper_mm: m.copper_mm, body_mm: m.body_mm, msg: m.copper_mm < 0 ? `${A.c.ref}: copper ${(-m.copper_mm).toFixed(2)} mm outside the outline` : m.body_mm < 0 ? `${A.c.ref}: body ${(-m.body_mm).toFixed(2)} mm outside the outline (pads ${m.copper_mm.toFixed(2)} mm inside)` : `${A.c.ref} is at the outline edge` }); }
      for (const k of keepouts()) if (k.parts && koOn(k, A.side) && ([...Array(25)].some((_, q) => inPoly(A.b[0] + (A.b[2] - A.b[0]) * (q % 5) / 4, A.b[1] + (A.b[3] - A.b[1]) * Math.floor(q / 5) / 4, k.pts)) || k.pts.some(([x, y]) => x > A.b[0] && x < A.b[2] && y > A.b[1] && y < A.b[3])))
        out.push({ type: 'keepout', parts: [A.c.ref], msg: `${A.c.ref} is inside keep-out "${k.name}"` });
      for (const h of S.pcb.holes || []) if (hit(A.b, [h.x - h.d / 2, h.y - h.d / 2, h.x + h.d / 2, h.y + h.d / 2])) out.push({ type: 'hole', parts: [A.c.ref], msg: `${A.c.ref} covers a mounting hole at (${h.x}, ${h.y})` });
    }
    if (o_.show_accepted) out.accepted = accepted;
    out.acceptedCount = okPairs.size;
    return out;
  }
  // overlaps the designer accepts (a module over parts on the other side, a holder over the plates): not reported again
  function markOverlapOk(pairs, remove) {
    const S = Model.S, cur = new Map((S.pcb.okOverlaps || []).map(p => [p.slice().sort().join('|'), p]));
    for (const p of pairs || []) { if (!Array.isArray(p) || p.length !== 2) throw new Error('pairs: [["U1", "U2"], …]'); for (const r of p) if (!Model.comp(r)) throw new Error('No component ' + r); const k = p.slice().sort().join('|'); if (remove) cur.delete(k); else cur.set(k, p.slice().sort()); }
    S.pcb.okOverlaps = [...cur.values()];
    return { accepted_overlaps: S.pcb.okOverlaps };
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
    return { board: boardBrief(), placed: cs.length, compacted: steps, fits: !still.length && !outside.length, overlapping: still.length ? still : undefined, outside: outside.length ? outside : undefined, seconds: +((Date.now() - t0) / 1000).toFixed(1) };
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
    return { board: boardBrief(), placed: cs.length, on_edge: edgeParts.map(e => `${e.c.ref}:${e.side}${e.plug ? ' (opening outward)' : ''}`) };
  }

  // Move / rotate one footprint, or put it on a board edge (plugs face outward, flush with the edge).
  function placeFootprint(ref, o = {}) {
    const S = Model.S, c = Model.comp(ref);
    if (!c || !Lib.footprint(c.footprint)) throw new Error(`No footprint for "${ref}"`);
    if (!S.board.w) throw new Error('No PCB yet — generate_pcb first');
    if (!c.pcb) c.pcb = { x: o.x != null ? +o.x : S.board.w / 2, y: o.y != null ? +o.y : S.board.h / 2, rot: 0 };   // a new part: put it on the board
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
  const JLC_MIN = { minTraceWidth: 0.1, minClearance: 0.1, minViaDrill: 0.15, minViaDiameter: 0.25, minAnnularRing: 0.05, minPthRing: 0.18, minHoleToHole: 0.5, minEdgeClearance: 0.2, minHoleSize: 0.15, minHoleToTrack: 0.2, minPthToTrack: 0.28 };
  // JLCPCB via pricing: no extra charge with hole ≥ 0.3 mm and diameter ≥ 0.4 mm; on boards with more than 2 layers a 0.2 mm
  // hole is also free when the diameter is ≥ 0.45 mm. Smaller vias cost extra. Diameter ≥ hole + 0.1 mm (0.15 preferred).
  const costsExtra = (v, layers = rules().layers) => !((v.drill >= 0.3 - 1e-9 && v.d >= 0.4 - 1e-9) || (layers > 2 && v.drill >= 0.2 - 1e-9 && v.d >= 0.45 - 1e-9));
  const costNote = v => `Via ${v.d}/${v.drill} mm (diameter/hole) costs extra at JLCPCB — no extra charge with hole ≥ 0.3 mm and diameter ≥ 0.4 mm (0.45 preferred) on 1–2 layer boards — pick the matching via option when ordering, or use 0.45/0.3`;
  // one line for exports / the datasheet: which via sizes the board uses, and whether that costs extra
  function viaSummary() {
    const S = Model.S, R = rules(), sizes = new Map();
    for (const v of S.pcb.vias || []) sizes.set(`${v.d}/${v.drill}`, v);
    if (!sizes.size) return `No vias (rule: ${R.viaDiameter}/${R.viaDrill} mm)`;
    return [...sizes.values()].map(v => `Vias ${v.d} mm diameter / ${v.drill} mm hole: ${costsExtra(v) ? 'COSTS EXTRA at JLCPCB — choose the matching via size when ordering' : 'JLCPCB standard, no extra cost'}`).join('; ');
  }
  const RULE_PRESETS = {
    jlcpcb_free_min: { label: 'JLCPCB 2-layer — small, no extra cost, clean in EasyEDA Pro DRC (0.2 mm tracks, 0.105 / 0.16 mm gaps, vias 0.45/0.3) — default', values: { traceWidth: 0.2, powerTraceWidth: 0.3, clearance: 0.105, padClearance: 0.16, viaClearance: 0.16, pourClearance: 0.26, viaDiameter: 0.45, viaDrill: 0.3, edgeClearance: 0.3, layers: 2, neckDown: true, ...JLC_MIN } },
    jlcpcb_tight: { label: 'JLCPCB 2-layer — tightest at no extra cost (0.1 mm everywhere; EasyEDA Pro needs its rules lowered)', values: { traceWidth: 0.2, powerTraceWidth: 0.3, clearance: 0.1, viaDiameter: 0.45, viaDrill: 0.3, edgeClearance: 0.2, layers: 2, neckDown: true, ...JLC_MIN } },
    jlcpcb: { label: 'JLCPCB 2-layer — standard (0.25 mm tracks, vias 0.6/0.3)', values: { traceWidth: 0.25, powerTraceWidth: 0.5, clearance: 0.2, viaDiameter: 0.6, viaDrill: 0.3, edgeClearance: 0.3, layers: 2, neckDown: true, ...JLC_MIN } },
    jlcpcb_min: { label: 'JLCPCB 2-layer — 5/5 mil', values: { traceWidth: 0.127, powerTraceWidth: 0.3, clearance: 0.127, viaDiameter: 0.56, viaDrill: 0.3, edgeClearance: 0.3, layers: 2, neckDown: true, ...JLC_MIN } },
    jlcpcb_power: { label: 'JLCPCB 2-layer — power / robust', values: { traceWidth: 0.3, powerTraceWidth: 0.8, clearance: 0.25, viaDiameter: 0.8, viaDrill: 0.4, edgeClearance: 0.5, layers: 2, neckDown: true, ...JLC_MIN } },
    home: { label: 'Home etching / CNC milling (1 layer)', values: { traceWidth: 0.4, powerTraceWidth: 0.8, clearance: 0.4, viaDiameter: 1.2, viaDrill: 0.6, edgeClearance: 1.0, layers: 1, neckDown: true, minTraceWidth: 0.3, minClearance: 0.3, minViaDrill: 0.5, minViaDiameter: 1.0, minAnnularRing: 0.25, minHoleToHole: 0.8, minEdgeClearance: 0.8, minHoleSize: 0.6 } },
  };
  const DEFAULT_PRESET = 'jlcpcb_free_min';
  // JLCPCB measures tracks against drill holes too: via hole to track ≥ minHoleToTrack (0.2), plated hole to track
  // ≥ minPthToTrack (0.28). As a copper gap: that minus the ring width — 0.125 mm for a 0.45 / 0.3 via
  // gaps per object kind: tracks to tracks = clearance; anything to a pad = padClearance; anything to a via = viaClearance;
  // copper pour to other copper = pourClearance (each at least clearance)
  const padCl = R => Math.max(R.clearance, +R.padClearance || 0), viaCl = R => Math.max(R.clearance, +R.viaClearance || 0);
  const pourCl = (R, pr) => (pr && pr.clearance) || Math.max(R.clearance, +R.pourClearance || 0);
  const viaGap = (R, d = R.viaDiameter, drill = R.viaDrill) => Math.max(viaCl(R), (+R.minHoleToTrack || 0) - (d - drill) / 2);
  const pthGap = (R, p) => Math.max(padCl(R), p.drill ? (+R.minPthToTrack || 0) - (Math.min(p.w, p.h) - p.drill) / 2 : 0);   // smallest JLCPCB rules at no extra cost
  function rules() {
    const r = Model.S.rules || {}, p = RULE_PRESETS[r.preset] || RULE_PRESETS[DEFAULT_PRESET];
    return Object.assign({ preset: DEFAULT_PRESET, netWidths: {}, routeTime: 90, trackStyle: '45', noViaInPad: true, pourMinArea: 0.5, warnUnderMetal: false, epKeepout: true }, p.values, r, { netWidths: Object.assign({}, r.netWidths || {}) });
  }
  // every net uses the rule's trace width; power / GND nets get the power width only when powerWider is on
  const netWidth = (R, net) => +(R.netWidths[net] || (R.powerWider && Model.isPower(net) ? R.powerTraceWidth : R.traceWidth));
  // Rules that violate the fab minimums (returned as warnings by setRules / DRC).
  function ruleWarnings(R) {
    const w = [], pv = RULE_PRESETS[R.preset] && RULE_PRESETS[R.preset].values;
    if (pv) { const diff = NUM_KEYS.filter(k => pv[k] != null && R[k] != null && Math.abs(+R[k] - +pv[k]) > 1e-9).map(k => `${k} ${R[k]} (preset ${pv[k]})`); if (diff.length) w.push(`Preset "${R.preset}", but these values differ from it: ${diff.join(', ')} — set_design_rules {preset: "${R.preset}"} resets them`); }
    if (R.traceWidth < R.minTraceWidth) w.push(`Trace width ${R.traceWidth} < fab minimum ${R.minTraceWidth} mm`);
    if (R.powerTraceWidth < R.minTraceWidth) w.push(`Power trace width ${R.powerTraceWidth} < fab minimum ${R.minTraceWidth} mm`);
    if (R.clearance < R.minClearance) w.push(`Clearance ${R.clearance} < fab minimum ${R.minClearance} mm`);
    if (R.viaDrill < R.minViaDrill) w.push(`Via drill ${R.viaDrill} < fab minimum ${R.minViaDrill} mm`);
    if (R.viaDiameter < R.minViaDiameter) w.push(`Via diameter ${R.viaDiameter} < fab minimum ${R.minViaDiameter} mm`);
    if ((R.viaDiameter - R.viaDrill) / 2 < R.minAnnularRing - 1e-9) w.push(`Via annular ring ${((R.viaDiameter - R.viaDrill) / 2).toFixed(3)} < fab minimum ${R.minAnnularRing} mm`);
    if (R.edgeClearance < R.minEdgeClearance) w.push(`Edge clearance ${R.edgeClearance} < fab minimum ${R.minEdgeClearance} mm`);
    if (R.viaDiameter - R.viaDrill < 0.1 - 1e-9) w.push('Via diameter must be at least 0.1 mm larger than the hole (JLCPCB; 0.15 mm preferred)');
    else if (R.viaDiameter - R.viaDrill < 0.15 - 1e-9) w.push(`Via ${R.viaDiameter}/${R.viaDrill} mm: JLCPCB prefers a diameter 0.15 mm larger than the hole (e.g. ${(R.viaDrill + 0.15).toFixed(2)} mm)`);
    if (costsExtra({ d: R.viaDiameter, drill: R.viaDrill })) w.push(costNote({ d: R.viaDiameter, drill: R.viaDrill }));
    for (const [n, v] of Object.entries(R.netWidths)) if (+v < R.minTraceWidth) w.push(`Net ${n} width ${v} < fab minimum ${R.minTraceWidth} mm`);
    return w;
  }
  const NUM_KEYS = ['traceWidth', 'powerTraceWidth', 'clearance', 'viaDiameter', 'viaDrill', 'edgeClearance', 'minTraceWidth', 'minClearance', 'minViaDrill', 'minViaDiameter', 'minAnnularRing', 'minPthRing', 'minHoleToHole', 'minEdgeClearance', 'minHoleSize', 'minHoleToTrack', 'minPthToTrack', 'padClearance', 'viaClearance', 'pourClearance', 'partGap'];
  // Merge a partial rule update into the project (preset first, then overrides).
  function setRules(u = {}) {
    let base = Model.S.rules || {};
    if (u.preset) {   // a preset sets the sizes and fab minimums; settings that are not sizes stay
      if (!RULE_PRESETS[u.preset]) throw new Error(`Unknown preset "${u.preset}". Presets: ${Object.keys(RULE_PRESETS).join(', ')}`);
      const keep = {}; for (const k of ['trackStyle', 'noViaInPad', 'viaInPad', 'warnUnderMetal', 'pourMinArea', 'routeTime', 'powerWider', 'epKeepout']) if (base[k] != null) keep[k] = base[k];
      base = Object.assign({ preset: u.preset, netWidths: base.netWidths || {} }, keep);
    }
    const next = Object.assign({}, base);
    for (const k of NUM_KEYS) if (u[k] != null && u[k] !== '') { const v = +u[k]; if (!(v >= 0 && v < 20) || (v === 0 && !/Clearance$|ToTrack$|^partGap$/.test(k))) throw new Error(`${k} must be a positive number in mm`); next[k] = v; }
    if (u.layers != null) { if (![1, 2].includes(+u.layers)) throw new Error('layers must be 1 or 2'); next.layers = +u.layers; }
    if (u.neckDown != null) next.neckDown = !!u.neckDown;
    if (u.powerWider != null) next.powerWider = !!u.powerWider;
    // allowing via-in-pad switches the strict rule off, and the other way round
    if (u.noViaInPad != null) next.noViaInPad = !!u.noViaInPad;
    if (u.viaInPad != null) next.viaInPad = !!u.viaInPad;
    if (next.viaInPad && (next.noViaInPad ?? true)) { if (u.viaInPad === true && u.noViaInPad !== true) next.noViaInPad = false; else next.viaInPad = false; }   // the strict rule is on unless switched off
    if (u.warnUnderMetal != null) next.warnUnderMetal = !!u.warnUnderMetal;
    if (u.epKeepout != null) next.epKeepout = !!u.epKeepout;
    // switching the automatic keep-outs back on brings back the ones removed one by one
    if (next.epKeepout && base.epKeepout === false && Model.S.pcb) delete Model.S.pcb.epKeepoutOff;
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
        : 'the router ran out of time or room — route_pcb again, optimize_pcb, more board area or ' + (rules().preset === 'jlcpcb_free_min' ? 'narrower tracks (traceWidth down to 0.1 mm)' : 'narrower rules (preset jlcpcb_free_min)'));
      r.failed_reason = fr;
    } else delete r.failed_reason;
    S.pcb.routeNotes = r.failed_reason ? Object.assign({}, r.failed_reason) : undefined;
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
      const rT = w / 2 + pthGap(R, p) + safe, rV = vr + Math.max(padCl(R), viaCl(R)) + safe, nr = p.near, hole = R.viaDrill / 2 + R.minHoleToHole;
      for (let k = 0; k < nr.length; k += 3) {
        const i = nr[k], d = nr[k + 1];
        if (d < rT) for (const l of p.layers) MT[l * N + i] += sgn;
        if (d < rV || nr[k + 2] < hole) MV[i] += sgn;
      }
    }
    function cuAdd(MT, MV, t, w, sgn) {
      const r1 = w / 2 + t.w / 2 + R.clearance + slack, r2 = vr + t.w / 2 + viaGap(R) + slack;
      for (const c of t.cells) { const x = c % W, y = (c / W) | 0; diskAdd(MT, t.l * N, x, y, r1, sgn); diskAdd(MV, 0, x, y, r2, sgn); }
    }
    function viaAdd(MT, MV, v, w, sgn) {
      const rt = w / 2 + v.d / 2 + (v.hole ? Math.max(R.clearance, +R.minHoleToTrack || 0) : viaGap(R, v.d, v.drill || R.viaDrill)) + safe, rv = Math.max(v.d / 2 + vr + viaCl(R), (v.hole ? v.d : R.viaDrill) / 2 + R.viaDrill / 2 + R.minHoleToHole);
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
            const big = p.ep && !R.noViaInPad && Math.min(p.w, p.h) >= 2 * R.viaDiameter + 0.4, nr = p.near, last = vip.has(id);
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
      // grow from the biggest island (most pads, then the one nearest the middle): when the first terminal is the pad that
      // cannot be reached, everything else would fail with it
      const mx = terms.reduce((a, T) => a + T.x, 0) / terms.length, my = terms.reduce((a, T) => a + T.y, 0) / terms.length;
      const si = terms.reduce((b, T, i) => (T.pads.length > terms[b].pads.length || (T.pads.length === terms[b].pads.length && Math.hypot(T.x - mx, T.y - my) < Math.hypot(terms[b].x - mx, terms[b].y - my))) ? i : b, 0);
      const s0 = job.pourCells ? 0 : si;   // a pour belongs to terms[0]: then that is the start
      let tree = new Set(terms[s0].cells), done = [terms[s0]], rest = terms.filter((T, i) => i !== s0), missed = [];
      const segs = [], vs = [];
      let ok = true, mapW = null, necked = false;
      const widths = [job.w];
      if (R.neckDown) for (const w2 of [R.traceWidth, R.minTraceWidth]) if (w2 < widths[widths.length - 1] - 1e-9) widths.push(w2);
      const grow = () => { while (rest.length) {
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
        if (!path) { ok = false; missed.push(target); continue; }
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
      } };
      grow();
      const main = new Set(done);
      // pads that could not join: they still connect among themselves (a second tree), so the copper that can be laid
      // is kept and only the real gap stays open
      let groups = 1;
      while (!dry && missed.length >= 2) { const m0 = missed; tree = new Set(m0[0].cells); done = [m0[0]]; rest = m0.slice(1); missed = []; groups++; grow(); if (missed.length >= m0.length - 1) break; }
      // the pads not joined to the main tree (this net's copper stays, only these connections are missing)
      const unreached = ok ? [] : [...new Set(terms.filter(T => !main.has(T)).flatMap(T => T.pads.map(q => q.key)).filter(Boolean))];
      if (!dry) { st.tcells.push(...myT); st.gvias.push(...myV); track(myT, myV, 1); }
      const blockers = dry ? blockersOf(dryPaths, job.w, id) : new Set();
      const len = segs.reduce((a, s) => { for (let i = 1; i < s.pts.length; i++) a += Math.hypot(s.pts[i][0] - s.pts[i - 1][0], s.pts[i][1] - s.pts[i - 1][1]); return a; }, 0);
      return { segs, vs, ok, necked, blockers, len, paths: dry ? dryPaths : null, unreached };
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
    // why a net failed, in words: the pads it could not join and what sits around them (other parts' pads, hand-drawn or
    // locked copper, keep-outs, the board edge) and whether a via fits beside the pad at all
    const reasonFor = n => {
      const r = result[n], miss = (r && r.unreached) || [];
      const pads = allPads.filter(p => miss.includes(p.key)).slice(0, 3);
      const near = pads.map(p => {
        const out = [], reach = Math.max(p.w, p.h) / 2 + R.traceWidth + R.clearance + 0.25;
        const other = allPads.filter(q => q.net !== p.net && Math.hypot(q.x - p.x, q.y - p.y) < reach + Math.max(q.w, q.h) / 2 && padCu(q, ['F', 'B']).some(l => padCu(p, ['F', 'B']).includes(l)));
        const parts = [...new Set(other.map(q => q.ref))].filter(rf => rf !== p.ref);
        if (other.some(q => q.ref === p.ref)) out.push('its neighbouring pins on ' + p.ref);
        if (parts.length) out.push('pads of ' + parts.slice(0, 3).join(', '));
        const fixedT = oldTraces.filter(t => t.net !== p.net && t.pts.some((q, i) => i && ptSeg([p.x, p.y], t.pts[i - 1], q) < reach + t.w / 2));
        if (fixedT.length) out.push(`${fixedT.length} kept track${fixedT.length > 1 ? 's' : ''} (${[...new Set(fixedT.map(t => t.net || 'no net'))].slice(0, 3).join(', ')}${fixedT.some(t => t.locked) ? ', locked' : fixedT.some(t => t.manual) ? ', hand-drawn' : ''})`);
        const fixedV = oldVias.filter(v => v.net !== p.net && Math.hypot(v.x - p.x, v.y - p.y) < reach + v.d / 2);
        if (fixedV.length) out.push(`${fixedV.length} kept via${fixedV.length > 1 ? 's' : ''}`);
        if (keepouts().some(k => (k.tracks || k.vias) && inPoly(p.x, p.y, k.pts))) out.push('a keep-out');
        const bp = boardPoly(); let de = Infinity; for (let i = 0; i < bp.length; i++) de = Math.min(de, ptSeg([p.x, p.y], bp[i], bp[(i + 1) % bp.length]));
        if (de < reach + R.edgeClearance) out.push('the board edge');
        // room for a via within 1.5 mm, clear of other copper
        let via = false;
        for (let rr = Math.max(p.w, p.h) / 2 + R.viaDiameter / 2 + 0.05; rr <= 1.5 && !via; rr += 0.1) for (let a = 0; a < 16 && !via; a++) {
          const x = p.x + rr * Math.cos(a * Math.PI / 8), y = p.y + rr * Math.sin(a * Math.PI / 8), vd = R.viaDiameter / 2;
          if (x < vd || y < vd || !inPoly(x, y, bp)) continue;
          if (allPads.some(q => q.net !== p.net && padDist(q, x, y) < vd + Math.max(padCl(R), viaCl(R)))) continue;
          if (oldTraces.some(t => t.net !== p.net && t.pts.some((q, i) => i && ptSeg([x, y], t.pts[i - 1], q) < vd + t.w / 2 + viaGap(R)))) continue;
          if (oldVias.some(v => v.net !== p.net && Math.hypot(v.x - x, v.y - y) < vd + v.d / 2 + viaCl(R))) continue;
          if (keepouts().some(k => k.vias && inPoly(x, y, k.pts))) continue;
          via = true;
        }
        if (!via && L > 1) out.push('no room for a via beside it');
        return `${p.key}: ${out.length ? out.join(', ') : 'tracks of other nets'}`;
      });
      const head = hard.has(n) ? 'no path even with the other routed nets ignored' : 'no room left between the tracks of the other nets';
      const tip = hard.has(n) ? (near.some(t => /no room for a via/.test(t)) ? 'move the parts next to that pin apart so a via fits' : near.some(t => /kept track|kept via/.test(t)) ? 'remove or move the kept copper (remove_tracks)' : 'move parts apart or make room')
        : 'optimize_pcb, more board area, or ' + (R.preset === 'jlcpcb_free_min' ? 'narrower tracks (traceWidth down to 0.1 mm)' : 'narrower rules (preset jlcpcb_free_min)');
      return `${head}${miss.length ? ` — not joined: ${miss.slice(0, 6).join(', ')}${miss.length > 6 ? ` (+${miss.length - 6})` : ''}` : ''}${near.length ? ` · blocked at ${near.join(' · ')}` : ''} — ${tip}${r && r.segs && r.segs.length ? ' (the rest of the net is routed)' : ''}`;
    };
    S.pcb = Object.assign({}, S.pcb, { traces: oldTraces.concat(fin.traces), vias: oldVias.concat(fin.vias), pours: S.pcb.pours || [], holes: S.pcb.holes || [], routed: fin.routed });
    return { routed: Object.keys(fin.routed).length, total: jobs.length, kept_tracks: oldTraces.length, failed: fin.failed, necked_down: fin.necked, vias: fin.vias.length, board: boardBrief(), grid_mm: +g.toFixed(3), seconds: +((Date.now() - t0) / 1000).toFixed(1), passes: attemptNo, ripup_iterations: iter, via_in_pad: todo.filter(j => vip.has(j.id) && fin.routed[j.net]).map(j => j.net), blocked_by_layout: [...hard].filter(n => fin.failed.includes(n)), failed_reason: fin.failed.length ? Object.fromEntries(fin.failed.map(n => [n, reasonFor(n)])) : undefined, search: stats, rules: { preset: R.preset, trace: R.traceWidth, power: R.powerTraceWidth, clearance: R.clearance, via: `${R.viaDiameter}/${R.viaDrill}`, layers: L } };
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
    for (const c of cs) for (const p of padsOf(c, idx)) objs.push({ s: padShape(p), net: p.net || '~' + (orphan++), layers: L === 1 ? ['F'] : padCu(p, ['F', 'B']), what: `pad ${p.key}`, drill: p.drill, ring: p.drill ? (Math.min(p.w, p.h) - p.drill) / 2 : undefined, x: p.x, y: p.y });
    { const bp = boardPoly(); for (const c of cs) {
      const m = partMargin(c, bp);
      if (m.copper_mm < 0) add('outline', `${c.ref}: copper ${(-m.copper_mm).toFixed(2)} mm outside the board outline`, c.pcb.x, c.pcb.y);
      else if (m.body_mm < -0.05) add('outline', `${c.ref}: body overhangs the outline by ${(-m.body_mm).toFixed(2)} mm (its pads are on the board)`, c.pcb.x, c.pcb.y, 'warning');
    } }
    // fine-pitch chips (pitch ≤ 0.5 mm): a pin that must change layer (power nets, nets that reach the other side) needs
    // room for a via near it — parts on the other side under the pins (decoupling caps) can take all of it
    if (L > 1) for (const w of viaRoomWarnings(cs, idx, R)) add('via-room', w.msg, w.x, w.y, 'warning');
    // rule partGap: part outlines on the same side (through-hole parts: both sides) at least this far apart
    if (+R.partGap > 0) {
      const ok = new Set((S.pcb.okOverlaps || []).map(p => p.slice().sort().join('|'))), bx = cs.map(c => ({ c, b: fpBox(c), side: isBottom(c) ? 'B' : 'F', th: padsOf(c).some(p => p.drill) }));
      for (let i = 0; i < bx.length; i++) for (let j = i + 1; j < bx.length; j++) {
        const A = bx[i], B = bx[j]; if (A.side !== B.side && !A.th && !B.th) continue;
        if (ok.has([A.c.ref, B.c.ref].sort().join('|'))) continue;
        const dx = Math.max(0, A.b[0] - B.b[2], B.b[0] - A.b[2]), dy = Math.max(0, A.b[1] - B.b[3], B.b[1] - A.b[3]), d = dx > 0 && dy > 0 ? Math.hypot(dx, dy) : Math.max(dx, dy);
        if (d < R.partGap - 1e-3) add('part-gap', `${A.c.ref} and ${B.c.ref} are ${d <= 0 ? 'overlapping' : d.toFixed(2) + ' mm apart'} (rule partGap ${R.partGap} mm between part outlines)`, (A.c.pcb.x + B.c.pcb.x) / 2, (A.c.pcb.y + B.c.pcb.y) / 2, 'warning');
      }
    }
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
      objs.push({ s: { k: 'circ', c: [v.x, v.y], r: v.d / 2 }, net: v.net || '~v' + S.pcb.vias.indexOf(v), layers: ['F', 'B'], what: `via ${v.net || '(no net)'}`, drill: v.drill, ring: (v.d - v.drill) / 2, x: v.x, y: v.y });
      if (v.drill < R.minViaDrill - 1e-6) add('via', `Via drill ${v.drill} < ${R.minViaDrill} mm`, v.x, v.y);
      if ((v.d - v.drill) / 2 < R.minAnnularRing - 1e-6) add('via', `Via annular ring ${((v.d - v.drill) / 2).toFixed(3)} < ${R.minAnnularRing} mm`, v.x, v.y);
      if (costsExtra(v) && !costWarned.has(v.d + '/' + v.drill)) { costWarned.add(v.d + '/' + v.drill); add('via-cost', costNote(v), v.x, v.y, 'warning'); }
      // via on an SMD pad of its own net: solder wicks into the hole (needs filled/capped vias at the fab)
      if (!R.viaInPad) for (const c of cs) for (const p of padsOf(c, idx)) {
        if (p.drill || p.net !== v.net || padDist(p, v.x, v.y) >= v.d / 2) continue;
        const big = p.ep && !R.noViaInPad && Math.min(p.w, p.h) >= 2 * v.d + 0.4, depth = Math.min(p.w / 2 - Math.abs(v.x - p.x), p.h / 2 - Math.abs(v.y - p.y));
        if (big && depth >= v.d / 2 + 0.15) continue; // thermal via well inside an exposed pad
        if (v.thermal && p.ep && depth >= v.d / 2 + 0.1) continue;   // placed by add_thermal_vias
        add('via-in-pad', `${R.noViaInPad ? 'Not allowed (rule: no via in pad): via' : 'Via'} on SMD pad ${p.key} (${v.net}) — solder wicks into the hole. ${Model.isGround(v.net) ? 'Add a GND copper pour (⬛ Pour GND) and route again — the pour connects GND without these vias — or' : 'Route again /'} ✨ Optimize to make room, or allow via-in-pad in the rules (filled vias cost extra at JLCPCB)`, v.x, v.y, R.noViaInPad ? 'error' : 'warning');
      }
    }
    (S.pcb.holes || []).forEach((h, i) => objs.push({ s: { k: 'circ', c: [h.x, h.y], r: h.d / 2 }, net: '~hole' + i, layers: ['F', 'B'], what: `mounting hole ${i + 1}`, drill: h.d, ring: 0, x: h.x, y: h.y }));
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
        if (bb[0] > ba[2] + Math.max(cl, R.minHoleToHole, +R.minPthToTrack || 0) + 2) break;
        if (bb[1] > ba[3] + cl + 2.3 || bb[3] < ba[1] - cl - 2.3) continue;
        const B = objs[j];
        if (A.drill && B.drill && A.what !== B.what) {
          const hd = Math.hypot(A.x - B.x, A.y - B.y) - A.drill / 2 - B.drill / 2;
          if (hd < R.minHoleToHole - 1e-3 && hd > -1e-6 && !(A.what.startsWith('pad') && B.what.startsWith('pad') && A.what.split('.')[0] === B.what.split('.')[0]))
            add('hole', `Holes ${A.what} / ${B.what} are ${hd.toFixed(3)} mm apart (minimum ${R.minHoleToHole})`, (A.x + B.x) / 2, (A.y + B.y) / 2, 'warning');
        }
        if (A.net === B.net || !A.layers.some(l => B.layers.includes(l))) continue;
        // tracks keep more distance from drill holes (vias, plated pads, mounting holes)
        let pc = cl, holeRule = false;
        if (A.what.startsWith('via') || B.what.startsWith('via')) pc = viaCl(R);
        else if ((A.what.startsWith('pad') && !B.what.startsWith('pad')) || (B.what.startsWith('pad') && !A.what.startsWith('pad'))) pc = padCl(R);
        for (const [X, Y] of [[A, B], [B, A]]) if (X.drill && Y.what.startsWith('trace')) {
          const ring = X.ring != null ? X.ring : 0, need = (X.what.startsWith('pad') ? (+R.minPthToTrack || 0) : (+R.minHoleToTrack || 0)) - ring;
          if (need > pc + 1e-9) { pc = +need.toFixed(3); holeRule = true; }
        }
        let d = shapeDist(A.s, B.s);
        if (d < pc - 1e-3 && (A.s.k === 'seg' && A.what.startsWith('trace') || B.s.k === 'seg' && B.what.startsWith('trace'))) d = refine(A, B, d);
        if (d < pc - 1e-3) {
          const key = [A.what, B.what].sort().join('|'); if (seen.has(key)) continue; seen.add(key);
          const both = A.what.startsWith('pad') && B.what.startsWith('pad');
          if (holeRule && d >= cl - 1e-3) {
            const H = A.what.startsWith('trace') ? B : A, T = H === A ? B : A, min = H.what.startsWith('pad') ? R.minPthToTrack : R.minHoleToTrack;
            add('hole-to-track', `${H.what} hole is ${(d + (H.ring || 0)).toFixed(3)} mm from ${T.what} (JLCPCB minimum ${min} mm hole to track)`, (A.x + B.x) / 2, (A.y + B.y) / 2, 'error');
          }
          else add(d <= 0 ? 'short' : 'clearance', `${d <= 0 ? 'Short' : 'Clearance ' + d.toFixed(3) + ' mm'} between ${A.what} and ${B.what} (rule ${pc})`, (A.x + B.x) / 2, (A.y + B.y) / 2,
            both ? 'warning' : (d < R.minClearance || d <= 0 ? 'error' : 'warning'));
        }
      }
    }
    // tracks / vias of other nets right under a battery, coin cell or metal part on the same side: only solder mask
    // separates them from the metal (a coin cell's face, a shield can)
    const METAL = /COIN|\bCR-?\d{4}|LIR-?\d{4}|BATT|BAT-|\bCELL\b|HOLDER|SHIELD|\bCAN\b|MAGNET|BUZZER/i;
    if (R.warnUnderMetal) for (const c of cs) {
      const lib = (c.lcsc && S.lib[c.lcsc]) || {}, txt = [c.value, c.type, c.footprint, lib.name, lib.package].filter(Boolean).join(' ');
      if (!METAL.test(txt)) continue;
      const side = isBottom(c) ? 'B' : 'F', b = fpBox(c, -0.2), pads = padsOf(c, idx), own = new Set(pads.map(p => p.net).filter(Boolean));
      const under = (x, y) => x > b[0] && x < b[2] && y > b[1] && y < b[3] && !pads.some(p => padDist(p, x, y) <= 0);
      const nets = new Set(); let n = 0, at = null;
      for (const t of S.pcb.traces) {
        if (t.layer !== side || own.has(t.net)) continue;
        let hit = false;
        for (let i = 1; i < t.pts.length && !hit; i++) { const a = t.pts[i - 1], q = t.pts[i], m = Math.max(1, Math.ceil(Math.hypot(q[0] - a[0], q[1] - a[1]) / 0.2)); for (let j = 0; j <= m && !hit; j++) { const x = a[0] + (q[0] - a[0]) * j / m, y = a[1] + (q[1] - a[1]) * j / m; if (under(x, y)) { hit = true; at = at || [x, y]; } } }
        if (hit) { n++; nets.add(t.net || '(no net)'); }
      }
      for (const v of S.pcb.vias) if (!own.has(v.net) && under(v.x, v.y)) { n++; nets.add(v.net || '(no net)'); at = at || [v.x, v.y]; }
      if (n) add('under-metal', `${n} track(s) / via(s) of ${[...nets].slice(0, 6).join(', ')} run under ${c.ref} (${c.value}) on the ${side === 'B' ? 'bottom' : 'top'} layer — only solder mask insulates them from its metal. Move them to the other layer, or add_keepout {ref: "${c.ref}", layer: "${side === 'B' ? 'bottom' : 'top'}"} and route again`, at[0], at[1], 'warning');
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
            add('keepout', `Track ${t.net || '(no net)'} enters ${tag}`, x, y, k.auto ? 'warning' : 'error'); return;
          }
        }
      });
      if (k.vias) for (const v of S.pcb.vias) if (!v.thermal && !(k.auto && v.net === k.epNet) && koDist(k, v.x, v.y) < v.d / 2 - 1e-3) add('keepout', `Via ${v.net || '(no net)'} inside ${tag}`, v.x, v.y, k.auto ? 'warning' : 'error');
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
      // islands of real copper: cells kept 0.075 mm further from other copper, so two neighbouring cells (also diagonal) have
      // copper at the full clearance between them (the plain raster could bridge a gap narrower than the clearance,
      // which EasyEDA and the fab see as unconnected)
      const ras = pourRaster(Object.assign({}, pr, { _margin: 0.075 })), first = nodes.length;
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
    const idx = Model.pinIndex(), on = [];
    for (const c of placed()) for (const p of padsOf(c, idx)) {
      if (p.drill) {   // a through-hole pad: no via on it, and the drill holes keep their spacing
        const holeGap = Math.hypot(v.x - p.x, v.y - p.y) - p.drill / 2 - v.drill / 2;
        if (padDist(p, v.x, v.y) < v.d / 2 + (p.net === v.net ? 0 : Math.max(padCl(R), viaCl(R))) || holeGap < R.minHoleToHole) on.push(p.key + ' (through-hole)');
        continue;
      }
      const need = p.net === v.net ? 0 : Math.max(padCl(R), viaCl(R)), gap = padDist(p, v.x, v.y) - v.d / 2;
      if (gap >= need - 1e-6) continue;
      if ((!R.noViaInPad || v.thermal) && p.ep && p.net === v.net && Math.min(p.w / 2 - Math.abs(v.x - p.x), p.h / 2 - Math.abs(v.y - p.y)) >= v.d / 2 + (v.thermal ? 0.1 : 0.15)) continue;   // thermal via in an exposed pad (only when the strict rule is off)
      // the same copper gap the DRC checks (edge to edge), said the same way
      on.push(p.net === v.net ? `${p.key} (its own net: vias may not sit on an SMD pad — put it beside the pad)` : `${p.key} (${p.net || 'no net'}): ${Math.max(0, gap).toFixed(3)} mm copper gap, needs ${need} mm`);
    }
    return on.length ? `Via at (${v.x}, ${v.y}) is too close to SMD pad ${on.join('; ')}` : null;
  }
  // copper, holes and the edge a new via / track must keep clear of (the 2D editor's live checks: pcbview obstacles)
  function viaObstacles(net, box) {
    const S = Model.S, R = rules(), idx = Model.pinIndex(), out = [], L2 = R.layers === 1 ? ['F'] : ['F', 'B'];
    const inBox = b => !box || !(b[0] > box[2] || b[2] < box[0] || b[1] > box[3] || b[3] < box[1]);
    const push = o => { if (inBox(bboxOf(o.s))) out.push(o); };
    for (const c of placed()) for (const p of padsOf(c, idx)) push({ s: padShape(p), what: 'pad ' + p.key, net: p.net || null, kind: 'pad', layers: padCu(p, L2), drill: p.drill, ring: p.drill ? (Math.min(p.w, p.h) - p.drill) / 2 : 0, c: [p.x, p.y], p });
    for (const v of S.pcb.vias) push({ s: { k: 'circ', c: [v.x, v.y], r: v.d / 2 }, what: `via (${v.x}, ${v.y})${v.net ? ' ' + v.net : ''}`, net: v.net || null, kind: 'via', layers: L2, drill: v.drill || R.viaDrill, ring: (v.d - (v.drill || R.viaDrill)) / 2, c: [v.x, v.y] });
    for (const t of S.pcb.traces) for (let i = 1; i < t.pts.length; i++) push({ s: { k: 'seg', a: t.pts[i - 1], b: t.pts[i], r: t.w / 2 }, what: `${t.net || ''} track (${t.layer === 'B' ? 'bottom' : 'top'})`, net: t.net || null, kind: 'track', layers: [t.layer] });
    (S.pcb.holes || []).forEach((h, i) => push({ s: { k: 'circ', c: [h.x, h.y], r: h.d / 2 }, what: 'mounting hole ' + (i + 1), net: null, kind: 'hole', layers: L2, drill: h.d, ring: 0, c: [h.x, h.y] }));
    const bp = boardPoly(); for (let i = 0; i < bp.length; i++) out.push({ s: { k: 'seg', a: bp[i], b: bp[(i + 1) % bp.length], r: 0 }, what: 'board edge', net: null, kind: 'edge', layers: L2 });
    return out;
  }
  const foreign = (o, net) => o.kind === 'edge' || o.kind === 'hole' || !net || o.net !== net;
  // what a via at (x, y) of `net` breaks (null when it fits): copper gaps on both layers, hole to track, hole to hole, edge, keep-outs, via in pad
  function viaSpotProblem(x, y, net, obs, R = rules(), d = R.viaDiameter, drill = R.viaDrill) {
    if (!inPoly(x, y, boardPoly())) return { what: 'outside the board', gap: -1, need: 0 };
    const vs = { k: 'circ', c: [x, y], r: d / 2 }, ring = (d - drill) / 2; let worst = null;
    const bad = (gap, need, what) => { if (gap < need - 1e-3 && (!worst || gap - need < worst.gap - worst.need)) worst = { gap: +gap.toFixed(3), need: +need.toFixed(3), what }; };
    for (const o of obs) {
      if (o.drill) bad(Math.hypot(x - o.c[0], y - o.c[1]) - drill / 2 - o.drill / 2, R.minHoleToHole, o.what + ' (hole to hole)');
      if (!foreign(o, net)) continue;
      const need = o.kind === 'track' ? Math.max(viaCl(R), (+R.minHoleToTrack || 0) - ring) : o.kind === 'edge' ? R.edgeClearance
        : o.kind === 'hole' ? Math.max(R.clearance, +R.minHoleToTrack || 0) : Math.max(viaCl(R), o.kind === 'pad' ? (o.drill ? pthGap(R, o.p) : padCl(R)) : 0);
      bad(shapeDist(vs, o.s), need, o.what);
    }
    for (const k of keepouts()) if (k.vias) bad(koDist(k, x, y) - d / 2, 0.05, `keep-out "${k.name}"`);
    if (!worst && net) { const vp = viaPadProblem({ net, x, y, d, drill }, R); if (vp) worst = { gap: 0, need: 0, what: vp.replace(/^Via at \([^)]*\) touches /, '').replace(/ — .*$/, '') + ' (no via in pad)' }; }
    return worst;
  }
  // Pins of fine-pitch chips with no room for a via within 1.6 mm (pads, holes, keep-outs and the edge only — tracks can
  // move). Checked for pins on power nets and on nets that reach a part on the other side: those need a via.
  function viaRoomWarnings(cs = placed(), idx = Model.pinIndex(), R = rules()) {
    const out = [], side = c => isBottom(c) ? 'B' : 'F', netSides = {};
    for (const c of cs) for (const p of padsOf(c, idx)) if (p.net) (netSides[p.net] = netSides[p.net] || new Set()).add(p.drill ? 'TH' : side(c));
    for (const c of cs) {
      const pads = padsOf(c, idx).filter(p => !p.drill); if (pads.length < 8) continue;
      let pitch = Infinity; for (let i = 0; i < pads.length; i++) for (let j = i + 1; j < pads.length; j++) pitch = Math.min(pitch, Math.hypot(pads[i].x - pads[j].x, pads[i].y - pads[j].y));
      if (pitch > 0.5 + 1e-6) continue;
      const stuck = [];
      for (const p of pads) {
        if (!p.net || p.ep) continue;
        const ns = netSides[p.net] || new Set(); if (!(Model.isPower && Model.isPower(p.net)) && !ns.has(side(c) === 'F' ? 'B' : 'F')) continue;
        const r0 = Math.max(p.w, p.h) / 2 + R.viaDiameter / 2 + 0.05, obs = viaObstacles(p.net, [p.x - 2.2, p.y - 2.2, p.x + 2.2, p.y + 2.2]).filter(o => o.kind !== 'track' && o.kind !== 'via');
        let ok = false;
        for (let rr = r0; rr <= 1.6 && !ok; rr += 0.1) for (let a = 0; a < 24 && !ok; a++) { const x = p.x + rr * Math.cos(a * Math.PI / 12), y = p.y + rr * Math.sin(a * Math.PI / 12); if (!viaSpotProblem(x, y, p.net, obs, R)) ok = true; }
        if (!ok) stuck.push(p);
      }
      if (!stuck.length) continue;
      const other = cs.filter(o => o !== c && side(o) !== side(c)), near = new Set();
      for (const p of stuck) for (const o of other) { const b = fpBox(o); if (p.x > b[0] - 1.6 && p.x < b[2] + 1.6 && p.y > b[1] - 1.6 && p.y < b[3] + 1.6) near.add(o.ref); }
      const nets = [...new Set(stuck.map(p => p.net))];
      out.push({ msg: `${c.ref} (${pitch.toFixed(2)} mm pitch): no room for a via within 1.6 mm of pin${stuck.length > 1 ? 's' : ''} ${stuck.slice(0, 6).map(p => p.num).join(', ')}${stuck.length > 6 ? ` (+${stuck.length - 6})` : ''} (${nets.slice(0, 4).join(', ')})${near.size ? ` — ${[...near].slice(0, 5).join(', ')} on the other side sit${near.size > 1 ? '' : 's'} under them` : ''}; move those parts a little away so a via fits`, x: stuck[0].x, y: stuck[0].y, part: c.ref, pins: stuck.map(p => p.key) });
    }
    return out;
  }
  // thermal vias in a part's exposed centre pad: a grid at `pitch` (default 1.0 mm), the vias at least 0.1 mm inside the
  // pad edge; earlier thermal vias of that pad are replaced
  function addThermalVias(o = {}) {
    const S = Model.S, R = rules(), c = Model.comp(o.ref); if (!c || !c.pcb) throw new Error('ref: a placed part with an exposed centre pad');
    if (R.layers === 1) throw new Error('The board has 1 copper layer — no vias');
    const fp = Lib.footprint(c.footprint), ep = fp ? exposedPads(fp) : new Set(), pad = padsOf(c, Model.pinIndex()).find(p => ep.has(p.num) && !p.drill);
    if (!pad) throw new Error(`${c.ref} has no exposed centre pad`);
    const d = +(o.diameter || R.viaDiameter), drill = +(o.drill || R.viaDrill), pitch = Math.max(d + R.minHoleToHole * 0.5, +(o.pitch || 1.0)), m = d / 2 + 0.1;
    const nx = Math.max(1, Math.floor((pad.w - 2 * m) / pitch) + 1), ny = Math.max(1, Math.floor((pad.h - 2 * m) / pitch) + 1);
    if (pad.w < 2 * m || pad.h < 2 * m) throw new Error(`${pad.key} is ${pad.w} × ${pad.h} mm — too small for a ${d} mm via with 0.1 mm to the pad edge`);
    if (!pad.net) throw new Error(`${pad.key} (the centre pad) is not on a net — connect it first (usually GND), then add thermal vias`);
    const net = pad.net, inPad = v => Math.abs(v.x - pad.x) < pad.w / 2 && Math.abs(v.y - pad.y) < pad.h / 2;
    const removed = S.pcb.vias.filter(v => v.thermal && inPad(v)).length;
    S.pcb.vias = S.pcb.vias.filter(v => !(v.thermal && inPad(v)));
    const n = Math.min(+(o.count || nx * ny), nx * ny), out = [];
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (out.length < n) out.push({ net, x: +(pad.x - (nx - 1) * pitch / 2 + i * pitch).toFixed(4), y: +(pad.y - (ny - 1) * pitch / 2 + j * pitch).toFixed(4), d, drill, manual: true, thermal: true });
    S.pcb.vias.push(...out);
    return { pad: pad.key, net, added: out.length, replaced: removed || undefined, grid: `${nx} × ${ny}`, pitch, via: `${d}/${drill}`, note: costsExtra({ d, drill }) ? costNote({ d, drill }) : undefined };
  }
  // Flex PCB: S.pcb.flex = { on, thickness, stiffeners: [{ name, pts, side, material, thickness }] }. A stiffener is a
  // rectangle, a polygon, or the area of a part (+ margin) — e.g. the solder-pad end of an electrode lead.
  const STIFF = { PI: [0.1, 0.25], FR4: [0.1, 1.6], steel: [0.1, 0.3] };
  function setFlex(o = {}) {
    const S = Model.S, f = Object.assign({ on: false, thickness: 0.12, stiffeners: [] }, S.pcb.flex || {});
    if (o.flex != null) f.on = !!o.flex; else if (o.thickness != null || o.stiffeners) f.on = true;
    if (o.thickness != null) { const t = +o.thickness; if (!(t >= 0.05 && t <= 0.4)) throw new Error('thickness: flex board thickness in mm (JLCPCB flex: 0.11 or 0.12; 0.2 with two layers and thicker copper)'); f.thickness = t; }
    if (o.clear_stiffeners) f.stiffeners = [];
    for (const st of o.stiffeners || []) {
      let pts = null;
      if (Array.isArray(st.rect) && st.rect.length === 4) { const [x0, y0, x1, y1] = st.rect.map(Number); pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]; }
      else if (Array.isArray(st.pts) && st.pts.length >= 3) pts = st.pts.map(q => [+q[0], +q[1]]);
      else if (st.ref) { const c = Model.comp(st.ref); if (!c || !c.pcb) throw new Error(`stiffener: ${st.ref} is not on the PCB`); const b = fpBox(c, +st.margin || 1); pts = [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]]; }
      if (!pts) throw new Error('each stiffener needs rect [x0, y0, x1, y1], pts [[x, y], …] or ref (+ margin)');
      const material = STIFF[st.material] ? st.material : 'PI', lim = STIFF[material], thickness = +(st.thickness || (material === 'PI' ? 0.2 : material === 'FR4' ? 0.2 : 0.2));
      if (thickness < lim[0] || thickness > lim[1]) throw new Error(`${material} stiffener thickness ${lim[0]}–${lim[1]} mm`);
      f.stiffeners.push({ name: String(st.name || `Stiffener ${f.stiffeners.length + 1}${st.ref ? ' (' + st.ref + ')' : ''}`).slice(0, 60), pts: pts.map(q => q.map(v => +v.toFixed(3))), side: st.side === 'top' ? 'top' : 'bottom', material, thickness, ref: st.ref || undefined });
    }
    S.pcb.flex = f;
    return { flex: f.on, thickness: f.thickness, stiffeners: f.stiffeners.map(s => ({ name: s.name, side: s.side, material: s.material, thickness: s.thickness, box: [Math.min(...s.pts.map(q => q[0])), Math.min(...s.pts.map(q => q[1])), Math.max(...s.pts.map(q => q[0])), Math.max(...s.pts.map(q => q[1]))] })),
      note: f.on ? 'Gerber export adds board-Stiffener.gm2 (stiffener outlines) and flex-notes.txt; order as Flex PCB at JLCPCB and give the stiffener specs there' : undefined };
  }
  // JLCPCB Open API pcbParam for this board (codes from JLCPCB's Online Quotation doc): o = {qty, color, finish,
  // thickness, remark}; colour 0 green 1 red 2 yellow 3 blue 4 white 5 black 6 purple; finish 0 HASL 1 lead-free HASL
  // 2 ENIG 3 OSP; plateType 7 = flex
  function jlcPcbParam(o = {}) {
    const S = Model.S, R = rules(), flex = S.pcb.flex && S.pcb.flex.on, finish = o.finish != null ? +o.finish : 1;
    return {
      layer: R.layers === 1 ? 1 : 2, width: +(+S.board.w).toFixed(2), length: +(+S.board.h).toFixed(2), qty: +(o.qty || 5),
      thickness: flex ? +(S.pcb.flex.thickness || 0.12) : +(o.thickness || 1.6), pcbColor: o.color != null ? +o.color : 0, surfaceFinish: finish, copperWeight: 1,
      goldFinger: 0, materialDetails: 0, panelFlag: 0, panelByJLCPCB_X: 0, panelByJLCPCB_Y: 0, differentDesign: 1, flyingProbeTest: 1,
      castellatedHoles: 0, orderDetailsRemark: String(o.remark || '').slice(0, 200), cascadeStructure: 0, impedanceFlag: 'no', isAddCustomerCode: 'yes',
      plateType: flex ? 7 : 1, autoConfirmProductionFile: true, markOnPcb: 1, viaCovering: 1, needTechnics: 0, edgeRounding: false, serviceConfigVos: [],
      ...(finish === 2 ? { goldThickness: 1 } : {}),
    };
  }
  const boardThickness = () => { const f = Model.S.pcb && Model.S.pcb.flex; return f && f.on ? +f.thickness || 0.12 : 1.6; };
  // what a straight track a→b of `net` on `layer` breaks (pads, vias and drill holes keep the router's larger gaps)
  function trackSpotProblem(a, b, w, layer, net, obs, R = rules(), skip) {
    const seg = { k: 'seg', a, b, r: w / 2 }; let worst = null;
    for (const o of obs) {
      if (!foreign(o, net) || o === skip || !o.layers.includes(layer)) continue;
      const need = o.kind === 'pad' ? (o.drill ? Math.max(padCl(R), (+R.minPthToTrack || 0) - o.ring) : padCl(R)) : o.kind === 'via' ? Math.max(viaCl(R), (+R.minHoleToTrack || 0) - o.ring)
        : o.kind === 'hole' ? Math.max(R.clearance, +R.minHoleToTrack || 0) : o.kind === 'edge' ? R.edgeClearance : R.clearance;
      const gap = shapeDist(seg, o.s); if (gap < need - 1e-3 && (!worst || gap - need < worst.gap - worst.need)) worst = { gap: +gap.toFixed(3), need: +need.toFixed(3), what: o.what };
    }
    if (!worst) for (const k of keepouts()) if (k.tracks && koOn(k, layer)) {
      const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.05));
      for (let i = 0; i <= n; i++) if (koDist(k, a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n) < w / 2) { worst = { gap: 0, need: w / 2, what: `keep-out "${k.name}"` }; break; }
    }
    return worst;
  }
  // is pad `key` in the biggest copper group of its net (or the net complete)?
  const padJoined = (net, key) => { const c = connectivity()[net]; if (!c || c.complete) return true; const main = c.groups.reduce((a, g) => g.length > a.length ? g : a, []); return main.some(p => p.key === key); };
  const say = b => `${b.gap <= 0 ? 'it would touch' : 'only ' + b.gap + ' mm to'} ${b.what}${b.need ? ` (needs ${b.need} mm)` : ''}`;
  // The closest legal via spot near a pad (or a point), placed; from a pad also a short straight track on the pad's layer.
  // From a pad of a net with a pour on the other layer, spots on that pour come first and the result is checked with connectivity().
  function viaNear(o, R = rules()) {
    const S = Model.S, nearPad = typeof o.near === 'string' ? findPad(o.near) : null;
    const p0 = nearPad ? [nearPad.x, nearPad.y] : Array.isArray(o.near) ? o.near.map(Number) : [+o.near.x, +o.near.y];
    if (!p0.every(isFinite)) throw new Error('near must be a pad ("U2.9") or a point [x, y] (board mm)');
    if (nearPad && !nearPad.net && !o.net) throw new Error(`${nearPad.key} is not on any net — connect it in the schematic first (connect), or give net`);
    const net = o.net || (nearPad && nearPad.net) || null; if (net && !S.nets[net]) throw new Error(`No net "${net}"`);
    if (nearPad && nearPad.net && net !== nearPad.net) throw new Error(`${nearPad.key} is on net ${nearPad.net}, not ${net}`);
    const d = +(o.diameter || R.viaDiameter), drill = +(o.drill || R.viaDrill), maxD = Math.max(0.2, Math.min(15, +(o.max_distance ?? 3))), w = net ? netWidth(R, net) : R.traceWidth;
    const layer = nearPad ? (nearPad.layer || 'F') : null, other = layer === 'B' ? 'F' : 'B';
    const reach = maxD + d + 2, obs = viaObstacles(net, [p0[0] - reach, p0[1] - reach, p0[0] + reach, p0[1] + reach]);
    const padObs = nearPad && obs.find(q => q.p && q.p.key === nearPad.key);
    // the net's pour on the other layer (from a pad) or on any layer (from a point), as connectivity() sees it
    const pours = (S.pcb.pours || []).filter(pr => net && pr.net === net && (!layer || pr.layer === other)).map(pr => pourRaster(Object.assign({}, pr, { _margin: 0.075 })));
    const onPour = (x, y) => { for (let i = 0; i < pours.length; i++) { const l = pours[i].at(x, y); if (l) return i * 1e6 + l; } return 0; };
    const step = Math.max(0.025, Math.min(0.1, +(o.grid || 0.05))), cand = [];
    for (let dy = -maxD; dy <= maxD + 1e-9; dy += step) for (let dx = -maxD; dx <= maxD + 1e-9; dx += step) { const r = Math.hypot(dx, dy); if (r <= maxD) cand.push([+(p0[0] + dx).toFixed(3), +(p0[1] + dy).toFixed(3), r]); }
    cand.sort((a, b) => a[2] - b[2]);
    const blockers = {}, note = what => { blockers[what] = (blockers[what] || 0) + 1; }, legal = [];
    for (const [x, y, r] of cand) {
      if (nearPad && padDist(nearPad, x, y) < d / 2 + 0.1) continue;   // on (or right at the edge of) the pad itself: solder would wick in
      const b = viaSpotProblem(x, y, net, obs, R, d, drill); if (b) { if (r < maxD * 0.6) note(b.what); continue; }
      const tb = nearPad ? trackSpotProblem([nearPad.x, nearPad.y], [x, y], w, layer, net, obs, R, padObs) : null;
      if (tb) { if (r < maxD * 0.6) note('track to the via: ' + tb.what); continue; }
      legal.push([x, y, r, pours.length ? onPour(x, y) : 0]);
    }
    const top = Object.entries(blockers).sort((a, b) => b[1] - a[1]).slice(0, 3).map(e => e[0]), at = nearPad ? nearPad.key : `(${p0.join(', ')})`;
    if (!legal.length) throw new Error(`No legal via spot within ${maxD} mm of ${at}${net ? ` (${net})` : ''}: ${top.length ? 'blocked by ' + top.join('; ') : 'too close to the pad itself'}. Try max_distance ${Math.min(15, maxD + 2)}, move that copper (remove_tracks + route again / move a part), or draw add_track from ${at} to a spot you choose`);
    const place = (x, y) => {
      const v = { net, x, y, d, drill, manual: true }, tr = nearPad ? { net, layer, w: +w.toFixed(4), pts: [[+nearPad.x.toFixed(4), +nearPad.y.toFixed(4)], [x, y]], manual: true } : null;
      S.pcb.vias.push(v); if (tr) S.pcb.traces.push(tr);
      return { v, tr, undo: () => { S.pcb.vias.splice(S.pcb.vias.indexOf(v), 1); if (tr) S.pcb.traces.splice(S.pcb.traces.indexOf(tr), 1); } };
    };
    let pick = null;
    if (nearPad && net && pours.length && !padJoined(net, nearPad.key)) {
      // spots on the other layer's pour first; one try per pour island (same island, same result)
      const tried = new Set();
      for (const c of legal) {
        if (!c[3] || tried.has(c[3]) || tried.size >= 10) continue; tried.add(c[3]);
        const t = place(c[0], c[1]); if (padJoined(net, nearPad.key)) { pick = { c, t }; break; } t.undo();
      }
      if (!pick) throw new Error(`${legal.length} legal via spots within ${maxD} mm of ${at}, but ${tried.size ? `none of them (${tried.size} pour pieces tried) joins it to the rest of ${net}` : `none is on the ${other === 'B' ? 'bottom' : 'top'} ${net} pour`} — try max_distance ${Math.min(15, maxD + 2)}, add_copper_pour {net: "${net}", layer: "both"}, or draw add_track from ${at} to ${net} copper`);
    } else { const c = legal.find(q => q[3]) || legal[0]; pick = { c, t: place(c[0], c[1]) }; }
    const cn = net ? connectivity()[net] : null;
    return {
      net, via: { index: S.pcb.vias.indexOf(pick.t.v), x: pick.c[0], y: pick.c[1], diameter: d, drill }, distance_mm: +pick.c[2].toFixed(3),
      track: pick.t.tr ? { index: S.pcb.traces.indexOf(pick.t.tr), layer: layer === 'B' ? 'bottom' : 'top', width: pick.t.tr.w, points: pick.t.tr.pts } : null,
      on_pour: !!pick.c[3], pad_joined: nearPad && net ? padJoined(net, nearPad.key) : undefined, net_complete: cn ? cn.complete : undefined, islands_left: cn ? cn.groups.length : undefined,
      ...(costsExtra({ d, drill }) ? { cost_note: costNote({ d, drill }) } : {}),
    };
  }
  // Every pad group of a pour net that connectivity() finds cut off from the main group gets a via (+ short track) from one of
  // its pads to the other layer's pour (viaNear); groups that cannot be joined say why.
  function connectPadsToPour(o = {}) {
    const S = Model.S, R = rules(), net = o.net || 'GND';
    if (R.layers === 1) throw new Error('The board has 1 copper layer — no vias');
    if (!S.nets[net]) throw new Error(`No net "${net}"`);
    if (!(S.pcb.pours || []).some(p => p.net === net)) throw new Error(`Net ${net} has no copper pour — add_copper_pour {net: "${net}", layer: "both"} first (or route it: route_pcb)`);
    const c0 = connectivity()[net];
    if (!c0 || c0.complete) return { net, net_complete: true, groups_fixed: 0, note: `${net} is already connected — nothing to do` };
    const before = new Set(drc().violations.map(v => v.msg)), report = [], keys = g => g.map(p => p.key).join();
    for (let round = 0; round < 40; round++) {
      const c = connectivity()[net]; if (!c || c.complete) break;
      const main = c.groups.reduce((a, g) => g.length > a.length ? g : a, []);
      const g = c.groups.find(gr => gr !== main && !report.some(r => r.pads.join() === keys(gr)));
      if (!g) break;
      const entry = { pads: g.map(p => p.key) }, tried = [];
      for (const p of g.slice().sort((a, b) => (a.drill ? 1 : 0) - (b.drill ? 1 : 0))) {   // SMD pads first
        try {
          const r = viaNear({ near: p.key, net, max_distance: o.max_distance, diameter: o.diameter, drill: o.drill }, R);
          if (r.pad_joined === false) { tried.push(`${p.key}: via placed but still not joined`); continue; }
          Object.assign(entry, { done: true, from: p.key, via: { x: r.via.x, y: r.via.y }, track: r.track && r.track.points, distance_mm: r.distance_mm }); break;
        } catch (e) { tried.push(`${p.key}: ${e.message}`); }
      }
      if (!entry.done) entry.why_not = tried.slice(0, 3);
      report.push(entry);
    }
    const c = connectivity()[net], fresh = drc().violations.filter(v => !before.has(v.msg) && v.type !== 'unrouted').slice(0, 20);
    return {
      net, groups: report, groups_fixed: report.filter(r => r.done).length, net_complete: !!(c && c.complete), islands_left: c ? c.groups.length : 0, new_drc_problems: fresh,
      note: c && !c.complete ? `Still ${c.groups.length} separate ${net} groups — for the rest: add_via {near: "PAD", max_distance: 5}, add_track from the pad to ${net} copper, move parts to make room, or reroute` : fresh.length ? 'New DRC problems — check them (run_drc) or undo' : undefined,
    };
  }
  function addVia(o = {}) {
    const S = Model.S, R = rules();
    if (R.layers === 1) throw new Error('The board has 1 copper layer — no vias');
    if (o.near != null) return viaNear(o, R);
    const x = +o.x, y = +o.y; if (!isFinite(x) || !isFinite(y)) throw new Error('x and y (board mm) are needed — or near: "U2.9" (a pad) / near: [x, y] to let CircuitPilot find the closest legal spot');
    if (o.net && !S.nets[o.net]) throw new Error(`No net "${o.net}"`);
    const v = { net: o.net || null, x: +x.toFixed(4), y: +y.toFixed(4), d: +(o.diameter || R.viaDiameter), drill: +(o.drill || R.viaDrill), manual: true };
    const bad = viaPadProblem(v, R); if (bad) throw new Error(bad + ` — or add_via {near: [${v.x}, ${v.y}]${v.net ? `, net: "${v.net}"` : ''}} finds the closest legal spot`);
    const rb = viaSpotProblem(v.x, v.y, v.net, viaObstacles(v.net, [x - 3, y - 3, x + 3, y + 3]), R, v.d, v.drill);
    S.pcb.vias.push(v);
    const i = S.pcb.vias.length - 1;
    return Object.assign({ index: i }, costsExtra(v) ? { note: costNote(v) } : {}, rb ? { warning: `This via breaks a rule: ${say(rb)} — remove_tracks {vias: [${i}]}, then add_via {near: [${v.x}, ${v.y}]${v.net ? `, net: "${v.net}"` : ''}} for the closest legal spot` } : {});
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
    return { placed: placed().length, components: S.components.length, board: boardBrief(), nets: nets.length, routed: routed.length, unrouted: nets.filter(n => !conn[n].complete), vias: S.pcb.vias.length, trace_length_mm: +len.toFixed(1) };
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
  // Tidy the reference labels: back to automatic placement (next to the part, off pads, parts and other labels); labels
  // that still cover pads get smaller (down to min_size) and, with hide: true, are hidden when there is no room at all.
  function arrangeSilk(o = {}) {
    const S = Model.S, only = o.refs && o.refs.length ? new Set(o.refs) : null, minH = Math.max(0.6, +(o.min_size || 0.8));
    const cs = placed().filter(c => !only || only.has(c.ref));
    for (const c of cs) if (c.pcb.silk) { const L = Object.assign({}, c.pcb.silk); delete L.dx; delete L.dy; if (o.unhide) delete L.hide; if (Object.keys(L).length) c.pcb.silk = L; else delete c.pcb.silk; }
    const bad = () => silkInfo().filter(l => l.kind === 'part' && l.covers_pads && (!only || only.has(l.ref))).map(l => l.ref);
    const shrunk = [], hidden = [];
    for (let h = 1.0; h >= minH - 1e-9; h = +(h - 0.2).toFixed(2)) {
      const b = bad(); if (!b.length) break;
      for (const r of b) { const c = Model.comp(r), L = Object.assign({}, c.pcb.silk || {}); if ((+L.h || SILK_H) > h) { L.h = h; c.pcb.silk = L; if (!shrunk.includes(r)) shrunk.push(r); } }
    }
    if (o.hide) for (const r of bad()) { const c = Model.comp(r); c.pcb.silk = Object.assign({}, c.pcb.silk || {}, { hide: true }); hidden.push(r); }
    const still = bad();
    return { arranged: cs.length, shrunk: shrunk.filter(r => !hidden.includes(r)), hidden, still_on_pads: still.length ? still : undefined, note: still.length ? 'No room for these labels next to their parts — move them (set_silk_label x/y), or arrange again with hide: true' : undefined };
  }
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
        const region = pts => { b.push('G36*', X(...pts[0]) + 'D02*'); for (const q of pts.slice(1)) b.push(X(...q) + 'D01*'); b.push(X(...pts[0]) + 'D01*', 'G37*'); };
        for (const pr of pours) {
          const cl = pourCl(R, pr);
          // the live pieces, traced just into the clearance band (holes cleared), then the band cleared with the exact
          // shapes of other nets' copper, the board edge and the keep-outs — dead copper is simply never drawn
          for (const rg of pourFill(pr).rings) { b.push(rg.hole ? '%LPC*%' : '%LPD*%'); region(rg.pts); }
          b.push('%LPC*%'); drawCopper(A, b, layer, 2 * cl, pr.net);
          b.push(A(`C,${f6(2 * R.edgeClearance)}`) + '*', X(...outline[0]) + 'D02*'); for (const q of outline.slice(1)) b.push(X(...q) + 'D01*'); b.push(X(...outline[0]) + 'D01*');
          for (const k of keepouts()) if (k.pours && koOn(k, layer)) region(k.pts);
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
    // flex board: stiffener outlines as a mechanical layer, and the specs to give with the order
    const flex = S.pcb.flex && S.pcb.flex.on ? S.pcb.flex : null;
    if (flex && (flex.stiffeners || []).length) files['board-Stiffener.gm2'] = file('Other,Stiffener', (A, b) => { b.push(A('C,0.100000') + '*'); for (const st of flex.stiffeners) { b.push(X(...st.pts[0]) + 'D02*'); for (const q of st.pts.slice(1)) b.push(X(...q) + 'D01*'); b.push(X(...st.pts[0]) + 'D01*'); } });
    if (flex) files['flex-notes.txt'] = `Flex PCB — ${S.name || 'board'}\nBoard thickness: ${flex.thickness} mm (polyimide), ${rules().layers === 1 ? '1 layer' : '2 layers'}\n` +
      ((flex.stiffeners || []).length ? 'Stiffeners (outlines in board-Stiffener.gm2):\n' + flex.stiffeners.map(st => `  ${st.name}: ${st.material} ${st.thickness} mm on the ${st.side} side, box ${[Math.min(...st.pts.map(q => q[0])), Math.min(...st.pts.map(q => q[1])), Math.max(...st.pts.map(q => q[0])), Math.max(...st.pts.map(q => q[1]))].map(v => v.toFixed(2)).join(', ')} mm`).join('\n') + '\n' : 'No stiffeners.\n') +
      'Order as "Flex PCB" at JLCPCB; choose the stiffener type and thickness there and attach board-Stiffener.gm2 (or note it in the remark).\n';
    // a 1-layer board has no bottom copper: its bottom files would only be empty (and confusing on the order)
    if (rules().layers === 1) {
      for (const f of ['board-B_Cu.gbl', 'board-B_Mask.gbs', 'board-B_Paste.gbp']) delete files[f];
      if (!placed().some(c => isBottom(c)) && !(S.pcb.texts || []).some(t => t.side === 'B')) delete files['board-B_Silkscreen.gbo'];
    }
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
      const margin = Math.max(+R.partGap || 0, Math.min(3, 0.4 + pitch * Math.sqrt(pins) * 0.6 + (boost[c.ref] || 0)));   // never below the rule partGap
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
    gap = Math.max(gap, +rules().partGap || 0);
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
    const area = c => { const fp = Lib.footprint(c.footprint), b = fp ? fp.box : [0, 0, 0, 0]; return (b[2] - b[0]) * (b[3] - b[1]); }, pinned = c => c.pcb && (c.pcb.locked || c.pcbEdge || edgeInfo(c));
    const move = new Set();
    // only real clashes move a placed part: pads closer than the clearance (courtyard-only overlaps of a dense layout,
    // opposite-side SMD parts and accepted overlaps stay as they are)
    const clashes = checkPlacement(null, 0, 0.25).filter(q => q.type === 'overlap' && q.pads_clear === false).map(q => q.parts.map(r => Model.comp(r)));
    for (const [a, b] of clashes) {
      if (move.has(a) || move.has(b)) continue;
      const pick = pinned(a) && pinned(b) ? null : pinned(a) ? b : pinned(b) ? a : area(a) <= area(b) ? a : b;
      if (pick) move.add(pick);
    }
    { const bp = boardPoly(); for (const c of placed()) if (!pinned(c) && partMargin(c, bp).copper_mm < 0) move.add(c); }   // copper off the board (a body corner past a curved edge is fine)
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
    return { iterations: it, routed: st.routed, total: st.nets, unrouted: st.unrouted, trace_length_mm: st.trace_length_mm, board: boardBrief(), seconds: +((Date.now() - t0) / 1000).toFixed(1), history };
  }

  return { pourFill, jlcPcbParam, setFlex, boardThickness, addThermalVias, epKeepouts, viaRoomWarnings, textWidth, rotPt, pourFillRings, viaGap, padCl, viaCl, pourCl, savePourTemplate, applyPourTemplate, describePour, markOverlapOk, boardBrief, partMargin, edgeMargins, autoFit, transformParts, clipPoly, arrangeSilk, viaSummary, costsExtra, checkPlacement, legalCheck, addTrack, addVia, trackList, removeTracks, connectPadsToPour, viaSpotProblem, addKeepout, removeKeepout, keepouts, pourInfo, pourIslands, stitchPour, placeFree, silkLabels, silkInfo, setSilkLabel, addText, updateText, removeText, labelCentre, strokeText, addMountingHoles, autoPlace, placeFootprint, syncFromSchematic, optimize, anneal, legalisePlacement, setBoardShape, boardPoly, isRectBoard, addPour, pourPoly, pourRaster, isBottom, padCu, inPoly, edgeInfo, route, status, gerbers, padsOf, fpBox, placed, rules, setRules, ruleWarnings, drc, RULE_PRESETS, connectivity, ratsnest, netWidth: n => netWidth(rules(), n), geom: { shapeDist, padShape, ptSeg, padDist, segSegDist } };
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
