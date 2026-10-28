'use strict';
// Script-driven 3D modelling for custom enclosures (wearables, chest patches, organic cases, clips…).
// A small CSG language for the AI and the user: primitives, hulls, extrusions, revolves, booleans, transforms.
// One script evaluates to meshes (STL, preview) and to equivalent OpenSCAD source.
// Uses the CSG kernel of enclosure.js. No DOM — runs in a Web Worker and in Node (MCP server).
const Shape3D = (() => {
  const K = () => Enclosure.csg;
  let FN = 0; // global resolution override (segments per full circle); 0 = adaptive
  let HQ3 = false;   // high quality (fabrication STL): ~0.4 mm curve segments, never fewer than 32 per circle
  const fnFor = (r, fn) => HQ3 ? Math.max(3, Math.round(Math.max(fn || 0, FN || 0, Math.min(144, Math.max(32, Math.ceil(2 * Math.PI * r / 0.4))))))
    : Math.max(3, Math.round(fn || FN || Math.max(12, Math.min(48, Math.ceil(2 * Math.PI * r / 1.2)))));
  const num = (v, name) => { const n = +v; if (!isFinite(n)) throw new Error(`${name} must be a number (got ${JSON.stringify(v)})`); return n; };
  const vec3 = (v, name = 'vector', def = 0) => {
    if (typeof v === 'number') return [v, v, v];
    if (!Array.isArray(v)) throw new Error(`${name} must be [x, y, z]`);
    return [0, 1, 2].map(i => v[i] == null ? def : num(v[i], name));
  };
  const f = v => { const s = (+v).toFixed(4).replace(/\.?0+$/, ''); return s === '-0' ? '0' : s; };
  const fv = v => '[' + v.map(f).join(', ') + ']';

  // ---------- mesh helpers ----------
  function mk(vs) { // dedupe consecutive vertices, build a polygon
    const { Poly } = K(), out = [];
    for (const v of vs) { const q = out[out.length - 1]; if (!q || Math.abs(q.x - v.x) + Math.abs(q.y - v.y) + Math.abs(q.z - v.z) > 1e-9) out.push(v); }
    while (out.length > 1 && Math.abs(out[0].x - out[out.length - 1].x) + Math.abs(out[0].y - out[out.length - 1].y) + Math.abs(out[0].z - out[out.length - 1].z) <= 1e-9) out.pop();
    return out.length >= 3 ? Poly.make(out) : null;
  }
  // merge vertices closer than tol (µm-scale leftovers of the booleans) and drop polygons that collapse
  function weld(polys, tol = 0.002) {
    const map = new Map(), cell = tol, kk = (i, j, k) => i + ',' + j + ',' + k;
    const rep = v => {
      const i = Math.floor(v.x / cell), j = Math.floor(v.y / cell), k = Math.floor(v.z / cell);
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) { const L = map.get(kk(i + a, j + b, k + c)); if (L) for (const u of L) if (Math.abs(u.x - v.x) < tol && Math.abs(u.y - v.y) < tol && Math.abs(u.z - v.z) < tol) return u; }
      const key = kk(i, j, k); let L = map.get(key); if (!L) map.set(key, L = []); L.push(v); return v;
    };
    for (const p of polys) p.v = p.v.map(rep).filter((v, i, a) => v !== a[(i + 1) % a.length]);
    return polys.filter(p => p.v.length >= 3 && new Set(p.v).size >= 3);
  }
  function volumeOf(polys) {
    let v = 0;
    for (const p of polys) for (let i = 1; i < p.v.length - 1; i++) { const a = p.v[0], b = p.v[i], c = p.v[i + 1]; v += a.dot(b.cross(c)) / 6; }
    return v;
  }
  function outward(polys) { // make a closed mesh face outward
    if (volumeOf(polys) < 0) for (const p of polys) p.flip();
    return polys;
  }
  function fromFaces(verts, faces) {
    const { V } = K(), P = verts.map(q => new V(q[0], q[1], q[2])), out = [];
    for (const fc of faces) { const p = mk(fc.map(i => P[i])); if (p) out.push(p); }
    return outward(out);
  }
  function bboxOf(polys) {
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const p of polys) for (const v of p.v) { if (v.x < b[0]) b[0] = v.x; if (v.y < b[1]) b[1] = v.y; if (v.z < b[2]) b[2] = v.z; if (v.x > b[3]) b[3] = v.x; if (v.y > b[4]) b[4] = v.y; if (v.z > b[5]) b[5] = v.z; }
    return b;
  }
  const overlap = (a, b, m = 0) => a[0] < b[3] + m && b[0] < a[3] + m && a[1] < b[4] + m && b[1] < a[4] + m && a[2] < b[5] + m && b[2] < a[5] + m;

  // ---------- 3D convex hull (quickhull: farthest point first, visible region grown through face adjacency) ----------
  function hull3(pts) {
    const { V, Poly, Plane } = K();
    const seen = new Map();
    for (const p of pts) { const k = `${Math.round(p.x * 1e4)},${Math.round(p.y * 1e4)},${Math.round(p.z * 1e4)}`; if (!seen.has(k)) seen.set(k, p); }
    const P = [...seen.values()];
    if (P.length < 4) throw new Error('hull() needs a 3D shape (at least 4 distinct points)');
    const b = bboxOf([{ v: P }]), scale = Math.max(b[3] - b[0], b[4] - b[1], b[5] - b[2]) || 1, eps = 1e-9 * scale * 64 + 1e-9;
    // initial tetrahedron from extreme points
    let i0 = 0, i1 = 0;
    for (let i = 0; i < P.length; i++) { if (P[i].x < P[i0].x) i0 = i; if (P[i].x > P[i1].x) i1 = i; }
    if (i0 === i1) i1 = P.findIndex((p, i) => i !== i0);
    const d01 = P[i1].minus(P[i0]);
    let i2 = -1, best = eps;
    for (let i = 0; i < P.length; i++) { const d = P[i].minus(P[i0]).cross(d01).len(); if (d > best) { best = d; i2 = i; } }
    if (i2 < 0) throw new Error('hull(): points are collinear');
    const n012 = P[i1].minus(P[i0]).cross(P[i2].minus(P[i0])).unit();
    let i3 = -1; best = eps;
    for (let i = 0; i < P.length; i++) { const d = Math.abs(P[i].minus(P[i0]).dot(n012)); if (d > best) { best = d; i3 = i; } }
    if (i3 < 0) throw new Error('hull(): points are flat — give the shapes some thickness');
    const edges = new Map(); // "a,b" → face owning the directed edge a→b
    const faces = [];
    const dist = (fc, p) => fc.n.dot(p) - fc.d;
    const newFace = (a, b, c) => {
      const n = P[b].minus(P[a]).cross(P[c].minus(P[a])), l = n.len();
      const fc = { v: [a, b, c], n: l > 0 ? n.times(1 / l) : n, d: 0, out: [], alive: true };
      fc.d = fc.n.dot(P[a]); faces.push(fc);
      edges.set(a + ',' + b, fc); edges.set(b + ',' + c, fc); edges.set(c + ',' + a, fc);
      return fc;
    };
    const ctr = P[i0].plus(P[i1]).plus(P[i2]).plus(P[i3]).times(0.25);
    for (const [a, b, c] of [[i0, i1, i2], [i0, i3, i1], [i0, i2, i3], [i1, i3, i2]]) {
      const n = P[b].minus(P[a]).cross(P[c].minus(P[a]));
      if (n.dot(ctr.minus(P[a])) > 0) newFace(a, c, b); else newFace(a, b, c);
    }
    const assign = (idxs, cands) => {
      for (const i of idxs) {
        let bf = null, bd = eps;
        for (const fc of cands) if (fc.alive) { const d = dist(fc, P[i]); if (d > bd) { bd = d; bf = fc; } }
        if (bf) bf.out.push(i);
      }
    };
    assign(P.map((_, i) => i).filter(i => i !== i0 && i !== i1 && i !== i2 && i !== i3), faces);
    for (let iter = 0; iter < 200000; iter++) {
      const f0 = faces.find(fc => fc.alive && fc.out.length);
      if (!f0) break;
      let eye = f0.out[0], ed = -1;
      for (const i of f0.out) { const d = dist(f0, P[i]); if (d > ed) { ed = d; eye = i; } }
      const E = P[eye];
      // visible region: flood from f0 across edges while the eye is strictly above the face
      const vis = new Set([f0]), stack = [f0], horizon = [];
      while (stack.length) {
        const fc = stack.pop();
        for (let k = 0; k < 3; k++) {
          const a = fc.v[k], b2 = fc.v[(k + 1) % 3], nb = edges.get(b2 + ',' + a);
          if (!nb || vis.has(nb)) continue;
          if (dist(nb, E) > eps) { vis.add(nb); stack.push(nb); } else horizon.push([a, b2]);
        }
      }
      const orphans = [];
      for (const fc of vis) {
        fc.alive = false;
        for (let k = 0; k < 3; k++) { const key = fc.v[k] + ',' + fc.v[(k + 1) % 3]; if (edges.get(key) === fc) edges.delete(key); }
        for (const i of fc.out) if (i !== eye) orphans.push(i);
        fc.out = [];
      }
      const made = horizon.map(([a, b2]) => newFace(a, b2, eye));
      assign(orphans, made);
      if ((iter & 255) === 255) for (let i = faces.length - 1; i >= 0; i--) if (!faces[i].alive) faces.splice(i, 1);
    }
    // merge coplanar neighbours into flat convex polygons (fewer, cleaner faces for the booleans)
    const live = faces.filter(fc => fc.alive), group = new Map();
    for (const fc of live) {
      if (group.has(fc)) continue;
      const g = [fc]; group.set(fc, g);
      for (let s = 0; s < g.length; s++) for (let k = 0; k < 3; k++) {
        const a = g[s].v[k], b2 = g[s].v[(k + 1) % 3], nb = edges.get(b2 + ',' + a);
        if (nb && nb.alive && !group.has(nb) && nb.n.dot(fc.n) > 1 - 1e-10 && Math.abs(nb.d - fc.d) < eps * 4) { group.set(nb, g); g.push(nb); }
      }
    }
    const out = [];
    for (const g of new Set(group.values())) {
      if (g.length === 1) { const p = mk(g[0].v.map(i => P[i])); if (p) out.push(p); continue; }
      // boundary of the merged region, walked in order
      const inner = new Set(); for (const fc of g) for (let k = 0; k < 3; k++) inner.add(fc.v[k] + ',' + fc.v[(k + 1) % 3]);
      const next = new Map();
      for (const fc of g) for (let k = 0; k < 3; k++) { const a = fc.v[k], b2 = fc.v[(k + 1) % 3]; if (!inner.has(b2 + ',' + a)) next.set(a, b2); }
      const start = next.keys().next().value, loop = [start];
      for (let c = next.get(start), guard = 0; c !== start && c != null && guard < 100000; c = next.get(c), guard++) loop.push(c);
      const n = g[0].n, pl = new Plane(new V(n.x, n.y, n.z), g[0].d);
      if (loop.length >= 3 && next.get(loop[loop.length - 1]) === start) out.push(new Poly(loop.map(i => P[i]), pl));
      else for (const fc of g) { const p = mk(fc.v.map(i => P[i])); if (p) out.push(p); }
    }
    return out;
  }

  // ---------- 2D shapes ----------
  class Shape2D {
    constructor(pts, src) { this.pts = K().ccw(K().dedupe(pts)); this.src = src || 'polygon'; if (this.pts.length < 3) throw new Error('2D shape needs at least 3 distinct points'); }
    _map(fn, flip) { const p = this.pts.map(fn); return new Shape2D(flip ? p.reverse() : p); }
    translate(v) { const x = num(v[0] || 0, 'x'), y = num(v[1] || 0, 'y'); return this._map(q => [q[0] + x, q[1] + y]); }
    rotate(deg) { const a = num(deg, 'angle') * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); return this._map(q => [q[0] * c - q[1] * s, q[0] * s + q[1] * c]); }
    scale(v) { const [sx, sy] = typeof v === 'number' ? [v, v] : [num(v[0], 'sx'), num(v[1] ?? v[0], 'sy')]; return this._map(q => [q[0] * sx, q[1] * sy], sx * sy < 0); }
    mirror(v) { const [mx, my] = [v[0] || 0, v[1] || 0], l = Math.hypot(mx, my) || 1, nx = mx / l, ny = my / l; return this._map(q => { const d = 2 * (q[0] * nx + q[1] * ny); return [q[0] - d * nx, q[1] - d * ny]; }, true); }
    offset(r) { return new Shape2D(K().offset(this.pts, num(r, 'offset'))); }
    get bounds() { const xs = this.pts.map(q => q[0]), ys = this.pts.map(q => q[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; }
    get area() { return Math.abs(K().area(this.pts)); }
    extrude(h, o) { return extrude(this, h, o); }
    revolve(o) { return revolve(this, o); }
    scad() { return `polygon(${'[' + this.pts.map(q => `[${f(q[0])}, ${f(q[1])}]`).join(', ') + ']'})`; }
  }
  // a 2D region: several outlines (outer ones counter-clockwise, holes clockwise) — the result of the 2D booleans.
  // Same methods as a 2D shape; booleans, offset and extrude run on the fast kernel (Manifold CrossSection).
  class Region2D {
    constructor(polys) { this.polys = (polys || []).filter(l => l.length >= 3).map(l => l.map(q => [+q[0], +q[1]])); if (!this.polys.length) throw new Error('the 2D result is empty (the shapes do not overlap / nothing is left)'); }
    _map(fn, flip) { return new Region2D(this.polys.map(l => { const m = l.map(fn); return flip ? m.reverse() : m; })); }
    translate(v) { const x = num(v[0] || 0, 'x'), y = num(v[1] || 0, 'y'); return this._map(q => [q[0] + x, q[1] + y]); }
    rotate(deg) { const a = num(deg, 'angle') * Math.PI / 180, c = Math.cos(a), si = Math.sin(a); return this._map(q => [q[0] * c - q[1] * si, q[0] * si + q[1] * c]); }
    scale(v) { const [sx, sy] = typeof v === 'number' ? [v, v] : [num(v[0], 'sx'), num(v[1] ?? v[0], 'sy')]; return this._map(q => [q[0] * sx, q[1] * sy], sx * sy < 0); }
    mirror(v) { const [mx, my] = [v[0] || 0, v[1] || 0], l = Math.hypot(mx, my) || 1, nx = mx / l, ny = my / l; return this._map(q => { const d = 2 * (q[0] * nx + q[1] * ny); return [q[0] - d * nx, q[1] - d * ny]; }, true); }
    // grow (> 0) / shrink (< 0) every outline; join: 'round' (default) | 'miter' | 'square'
    offset(r, o = {}) { const J = { round: 'Round', miter: 'Miter', square: 'Square' }[o.join || 'round']; return regionOf(kept(cs2(this).offset(num(r, 'offset'), J, 2, o.fn || 0))); }
    get pts() { return this.polys.reduce((a, l) => Math.abs(K().area(l)) > Math.abs(K().area(a)) ? l : a); }   // the largest outline (for hulls)
    get bounds() { const xs = this.polys.flat().map(q => q[0]), ys = this.polys.flat().map(q => q[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; }
    get area() { return this.polys.reduce((a, l) => a + K().area(l), 0); }
    extrude(h, o) { return extrude(this, h, o); }
    revolve() { throw new Error('revolve(): use a single 2D shape (not the result of a 2D boolean)'); }
    scad() { let k = 0; return `polygon(points=[${this.polys.flat().map(q => `[${f(q[0])}, ${f(q[1])}]`).join(', ')}], paths=[${this.polys.map(l => '[' + l.map(() => k++).join(', ') + ']').join(', ')}])`; }
  }
  const need2fast = fn => { if (!MK) throw new Error(`${fn}() needs the fast 3D kernel (WebAssembly), which could not be loaded here`); };
  const cs2 = sh => { need2fast('2D boolean'); return kept(MF.CrossSection.ofPolygons(sh instanceof Region2D ? sh.polys : [sh.pts], 'Positive')); };
  const regionOf = cs => new Region2D(cs.toPolygons().map(l => l.map(q => [q[0], q[1]])));
  const bool2 = (op, list) => { const L = list.flat(Infinity).filter(Boolean).map(x => { if (!is2(x)) throw new Error(`${op}2d(): needs 2D shapes`); return cs2(x); }); if (!L.length) throw new Error(`${op}2d() of nothing`); return regionOf(kept(MF.CrossSection[op === 'union' ? 'union' : op === 'difference' ? 'difference' : 'intersection'](L))); };
  const is2 = s => s instanceof Shape2D || s instanceof Region2D;
  const need2 = (s, fn) => { if (!is2(s)) throw new Error(`${fn}() needs a 2D shape (square, rect, circle, ellipse, roundedRect, polygon, pcbOutline …)`); return s; };
  function circlePts(rx, ry, n) { return Array.from({ length: n }, (_, k) => [rx * Math.cos(k / n * 2 * Math.PI), ry * Math.sin(k / n * 2 * Math.PI)]); }
  const api2 = {
    square(size, o = {}) { const [w, h] = typeof size === 'number' ? [size, size] : [num(size[0], 'width'), num(size[1] ?? size[0], 'height')]; const x0 = o.center ? -w / 2 : 0, y0 = o.center ? -h / 2 : 0; return new Shape2D([[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]]); },
    rect(w, h, o = {}) { return api2.square([w, h], Object.assign({ center: true }, o)); },
    circle(r, o = {}) { if (typeof r === 'object') { o = r; r = o.r ?? o.d / 2; } r = num(r, 'r'); return new Shape2D(circlePts(r, r, fnFor(r, o.fn))); },
    ellipse(rx, ry, o = {}) { rx = num(rx, 'rx'); ry = num(ry ?? rx, 'ry'); return new Shape2D(circlePts(rx, ry, fnFor(Math.max(rx, ry), o.fn))); },
    roundedRect(w, h, r, o = {}) {
      w = num(w, 'width'); h = num(h, 'height'); r = Math.max(0, Math.min(num(r || 0, 'radius'), w / 2 - 1e-6, h / 2 - 1e-6));
      if (r <= 1e-6) return api2.rect(w, h, o);
      const n = Math.max(2, Math.ceil(fnFor(r, o.fn) / 4)), pts = [];
      for (const [cx, cy, a0] of [[w / 2 - r, h / 2 - r, 0], [-w / 2 + r, h / 2 - r, 90], [-w / 2 + r, -h / 2 + r, 180], [w / 2 - r, -h / 2 + r, 270]])
        for (let k = 0; k <= n; k++) { const a = (a0 + 90 * k / n) * Math.PI / 180; pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
      const s = new Shape2D(pts); return o.center === false ? s.translate([w / 2, h / 2]) : s;
    },
    polygon(pts) { if (!Array.isArray(pts)) throw new Error('polygon() needs [[x,y], …]'); return new Shape2D(pts.map(q => [num(q[0], 'x'), num(q[1], 'y')])); },
    hull2d(...shapes) {
      const P = shapes.flat().flatMap(s => need2(s, 'hull2d').pts).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]), lo = [], up = [];
      for (const p of P) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
      for (const p of P.slice().reverse()) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
      return new Shape2D(lo.slice(0, -1).concat(up.slice(0, -1)));
    },
  };

  // ---------- 3D shapes (lazy node tree → polygons + OpenSCAD) ----------
  class Shape {
    constructor(node) { this.node = node; }
    get polys() { return MK ? polysOfM(evalM(this.node)) : evalNode(this.node); }
    translate(v) { return new Shape({ op: 'translate', v: vec3(v, 'translate'), c: [this.node] }); }
    rotate(a, axis) {
      if (axis) return new Shape({ op: 'rotate', a: num(a, 'angle'), axis: vec3(axis, 'axis'), c: [this.node] });
      return new Shape({ op: 'rotate', v: typeof a === 'number' ? [0, 0, a] : vec3(a, 'rotate'), c: [this.node] });
    }
    scale(v) { return new Shape({ op: 'scale', v: vec3(v, 'scale', 1), c: [this.node] }); }
    mirror(v) { return new Shape({ op: 'mirror', v: vec3(v, 'mirror'), c: [this.node] }); }
    color(c) { return new Shape({ op: 'color', col: String(c), c: [this.node] }); }
    // deform every vertex: fn([x, y, z]) changes the array in place (refine() first for smooth bends)
    warp(fn) { if (typeof fn !== 'function') throw new Error('warp(fn): fn([x, y, z]) must change the point in place'); return new Shape({ op: 'warp', fn, c: [this.node] }); }
    refine(len = 1) { len = num(len, 'refine length'); if (len <= 0.05) throw new Error('refine(len): len > 0.05 mm'); return new Shape({ op: 'refine', len, c: [this.node] }); }
    // organic: a smooth surface through the corners; edges sharper than angle (degrees) keep a crease of `smoothness` (0 = sharp)
    smooth(o = {}) { if (typeof o === 'number') o = { refine: o }; return new Shape({ op: 'smooth', angle: num(o.angle ?? 60, 'angle'), smoothness: Math.max(0, Math.min(1, num(o.smoothness ?? 0, 'smoothness'))), len: Math.max(0.2, num(o.refine ?? 1, 'refine')), c: [this.node] }); }
    // keep the side of the plane the normal points to (offset = distance of the plane from the origin)
    trim(normal, offset = 0) { return new Shape({ op: 'trim', normal: vec3(normal, 'normal'), offset: num(offset, 'offset'), c: [this.node] }); }
    // wrap around a cylinder of radius R below the shape (wrist / arm / chest curve): lines along `along` (x | y) follow it,
    // z = o.z (default 0) keeps its length; the ends drop
    bend(R, o = {}) {
      R = num(R, 'bend radius'); if (R <= 1) throw new Error('bend(R): R > 1 mm'); const z0 = num(o.z ?? 0, 'z'), ax = o.along === 'x' ? 0 : 1;
      return this.refine(o.refine ?? Math.max(0.6, Math.min(2, R / 30))).warp(q => { const rr = R + q[2] - z0, a = q[ax] / R; q[ax] = rr * Math.sin(a); q[2] = z0 - R + rr * Math.cos(a); });
    }
    mirrorCopy(v) { return union(this, this.mirror(v)); }
    // copies: .array(n, [dx, dy, dz]) in a row, .grid(nx, ny, dx, dy) centred, .polar(n, {angle = 360, start = 0}) around Z
    array(n, step) { const d = vec3(step, 'step'); return union(Array.from({ length: Math.max(1, Math.round(n)) }, (_, i) => this.translate([d[0] * i, d[1] * i, d[2] * i]))); }
    grid(nx, ny, dx, dy, o = {}) { const ox = o.center === false ? 0 : -(nx - 1) * dx / 2, oy = o.center === false ? 0 : -(ny - 1) * dy / 2, L = []; for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) L.push(this.translate([ox + i * dx, oy + j * dy, 0])); return union(L); }
    polar(n, o = {}) { const a = num(o.angle ?? 360, 'angle'), st = a >= 360 ? a / n : a / Math.max(1, n - 1); return union(Array.from({ length: Math.max(1, Math.round(n)) }, (_, i) => this.rotate([0, 0, (o.start || 0) + i * st]))); }
    union(...o) { return union(this, ...o); }
    subtract(...o) { return difference(this, ...o); }
    difference(...o) { return difference(this, ...o); }
    intersect(...o) { return intersection(this, ...o); }
    get bounds() { const b = MK ? mBounds(evalM(this.node)) : bboxOf(this.polys); return { min: b.slice(0, 3), max: b.slice(3), size: [b[3] - b[0], b[4] - b[1], b[5] - b[2]] }; }
  }
  const need3 = (s, fn) => { if (s instanceof Shape) return s.node; if (is2(s)) throw new Error(`${fn}(): got a 2D shape — extrude() or revolve() it first${/union|difference|intersection/.test(fn) ? ` (or ${fn}2d() for a 2D result)` : ''}`); throw new Error(`${fn}(): expected a 3D shape, got ${s === undefined ? 'undefined' : typeof s}`); };
  const list = (args, fn) => args.flat(Infinity).filter(s => s != null && s !== false).map(s => need3(s, fn));

  function matrixOf(n) {
    const I = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]];
    if (n.op === 'translate') return [[1, 0, 0, n.v[0]], [0, 1, 0, n.v[1]], [0, 0, 1, n.v[2]]];
    if (n.op === 'scale') return [[n.v[0], 0, 0, 0], [0, n.v[1], 0, 0], [0, 0, n.v[2], 0]];
    if (n.op === 'mirror') { const l = Math.hypot(...n.v) || 1, [a, b, c] = n.v.map(x => x / l); return [[1 - 2 * a * a, -2 * a * b, -2 * a * c, 0], [-2 * a * b, 1 - 2 * b * b, -2 * b * c, 0], [-2 * a * c, -2 * b * c, 1 - 2 * c * c, 0]]; }
    if (n.op === 'rotate') {
      if (n.axis) {
        const l = Math.hypot(...n.axis) || 1, [x, y, z] = n.axis.map(q => q / l), t = n.a * Math.PI / 180, c = Math.cos(t), s = Math.sin(t), C = 1 - c;
        return [[c + x * x * C, x * y * C - z * s, x * z * C + y * s, 0], [y * x * C + z * s, c + y * y * C, y * z * C - x * s, 0], [z * x * C - y * s, z * y * C + x * s, c + z * z * C, 0]];
      }
      const [ax, ay, az] = n.v.map(d => d * Math.PI / 180);
      const Rx = [[1, 0, 0], [0, Math.cos(ax), -Math.sin(ax)], [0, Math.sin(ax), Math.cos(ax)]];
      const Ry = [[Math.cos(ay), 0, Math.sin(ay)], [0, 1, 0], [-Math.sin(ay), 0, Math.cos(ay)]];
      const Rz = [[Math.cos(az), -Math.sin(az), 0], [Math.sin(az), Math.cos(az), 0], [0, 0, 1]];
      const mul = (A, B) => A.map((r, i) => [0, 1, 2].map(j => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
      const R = mul(Rz, mul(Ry, Rx)); // OpenSCAD order: X, then Y, then Z
      return R.map(r => r.concat(0));
    }
    return I;
  }
  function transform(polys, M) {
    const { V } = K();
    const det = M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
    const out = [];
    for (const p of polys) {
      let vs = p.v.map(v => new V(M[0][0] * v.x + M[0][1] * v.y + M[0][2] * v.z + M[0][3], M[1][0] * v.x + M[1][1] * v.y + M[1][2] * v.z + M[1][3], M[2][0] * v.x + M[2][1] * v.y + M[2][2] * v.z + M[2][3]));
      if (det < 0) vs = vs.reverse();
      const q = mk(vs); if (q) out.push(q);
    }
    return out;
  }
  let budget = null; // time guard for heavy booleans
  function evalNode(n) {
    if (n._p) return n._p;
    const C = K();
    let P;
    switch (n.op) {
      case 'cube': {
        const [x, y, z] = n.size, o = n.center ? [-x / 2, -y / 2, -z / 2] : [0, 0, 0];
        const v = [[0, 0, 0], [x, 0, 0], [x, y, 0], [0, y, 0], [0, 0, z], [x, 0, z], [x, y, z], [0, y, z]].map(q => [q[0] + o[0], q[1] + o[1], q[2] + o[2]]);
        P = fromFaces(v, [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]); break;
      }
      case 'cylinder': {
        const fn = fnFor(Math.max(n.r1, n.r2), n.fn), z0 = n.center ? -n.h / 2 : 0, z1 = z0 + n.h, v = [], faces = [];
        for (let k = 0; k < fn; k++) { const a = k / fn * 2 * Math.PI; v.push([n.r1 * Math.cos(a), n.r1 * Math.sin(a), z0]); }
        for (let k = 0; k < fn; k++) { const a = k / fn * 2 * Math.PI; v.push([n.r2 * Math.cos(a), n.r2 * Math.sin(a), z1]); }
        for (let k = 0; k < fn; k++) { const j = (k + 1) % fn; faces.push([k, j, fn + j, fn + k]); }
        faces.push(Array.from({ length: fn }, (_, k) => fn - 1 - k), Array.from({ length: fn }, (_, k) => fn + k));
        P = fromFaces(v, faces.map(fc => fc)).filter(Boolean); break;
      }
      case 'sphere': {
        const fn = fnFor(n.r, n.fn), rings = Math.max(2, Math.round(fn / 2)), v = [], faces = [];
        for (let i = 0; i <= rings; i++) { const ph = Math.PI * i / rings; for (let k = 0; k < fn; k++) { const th = 2 * Math.PI * k / fn; v.push([n.r * Math.sin(ph) * Math.cos(th), n.r * Math.sin(ph) * Math.sin(th), n.r * Math.cos(ph)]); } }
        for (let i = 0; i < rings; i++) for (let k = 0; k < fn; k++) { const a = i * fn + k, b = i * fn + (k + 1) % fn, c = (i + 1) * fn + (k + 1) % fn, d = (i + 1) * fn + k; faces.push([a, d, c, b]); }
        P = fromFaces(v, faces); break;
      }
      case 'torus': {
        const fn = fnFor(n.R + n.r, n.fn), fn2 = fnFor(n.r, n.fn2), v = [], faces = [];
        for (let i = 0; i < fn; i++) { const th = 2 * Math.PI * i / fn; for (let k = 0; k < fn2; k++) { const ph = 2 * Math.PI * k / fn2, rr = n.R + n.r * Math.cos(ph); v.push([rr * Math.cos(th), rr * Math.sin(th), n.r * Math.sin(ph)]); } }
        for (let i = 0; i < fn; i++) for (let k = 0; k < fn2; k++) { const i2 = (i + 1) % fn, k2 = (k + 1) % fn2; faces.push([i * fn2 + k, i2 * fn2 + k, i2 * fn2 + k2, i * fn2 + k2]); }
        P = fromFaces(v, faces); break;
      }
      case 'extrude': {
        if (n.shape.polys) throw new Error('extruding the result of a 2D boolean needs the fast 3D kernel (WebAssembly)');
        const pts = n.shape.pts, m = pts.length, z0 = n.center ? -n.h / 2 : 0, z1 = z0 + n.h, s = n.scale, v = [], faces = [];
        for (const q of pts) v.push([q[0], q[1], z0]);
        for (const q of pts) v.push([q[0] * s[0], q[1] * s[1], z1]);
        for (let k = 0; k < m; k++) { const j = (k + 1) % m; faces.push([k, j, m + j, m + k]); }
        for (const [a, b, c] of C.earcut(pts)) { faces.push([c, b, a]); faces.push([m + a, m + b, m + c]); }
        P = fromFaces(v, faces); break;
      }
      case 'revolve': {
        const pts = n.shape.pts, m = pts.length, full = n.angle >= 360 - 1e-9;
        if (pts.some(q => q[0] < -1e-9)) throw new Error('revolve(): the profile must lie at x ≥ 0 (x = distance from the Z axis, y = height)');
        const fn = fnFor(Math.max(...pts.map(q => q[0])), n.fn), steps = full ? fn : Math.max(1, Math.ceil(fn * n.angle / 360)), rings = full ? steps : steps + 1, v = [], faces = [];
        for (let i = 0; i < rings; i++) { const a = n.angle * Math.PI / 180 * i / steps; for (const q of pts) v.push([q[0] * Math.cos(a), q[0] * Math.sin(a), q[1]]); }
        for (let i = 0; i < steps; i++) { const i2 = full ? (i + 1) % steps : i + 1; for (let k = 0; k < m; k++) { const k2 = (k + 1) % m; faces.push([i * m + k, i * m + k2, i2 * m + k2, i2 * m + k]); } }
        if (!full) for (const [a, b, c] of C.earcut(pts)) { faces.push([a, b, c]); faces.push([steps * m + c, steps * m + b, steps * m + a]); }
        P = fromFaces(v, faces); break;
      }
      case 'roundedBox': {
        const [x, y, z] = n.size, r = n.r, o = n.center ? [0, 0, 0] : [x / 2, y / 2, z / 2], pts = [];
        const sp = evalNode({ op: 'sphere', r, fn: n.fn });
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) for (const p of sp) for (const v of p.v) pts.push(v.plus(new C.V(o[0] + sx * (x / 2 - r), o[1] + sy * (y / 2 - r), o[2] + sz * (z / 2 - r))));
        P = hull3(pts); break;
      }
      case 'hull': P = hull3(n.c.flatMap(c => evalNode(c).flatMap(p => p.v))); break;
      case 'rings': P = hull3(n.rings.flatMap(r => r.pts.map(q => new C.V(q[0], q[1], r.z)))); break;
      case 'union': P = n.c.map(evalNode).reduce((a, b) => { tick(); return C.union(a, b); }); break;
      case 'difference': { P = evalNode(n.c[0]); const rest = n.c.slice(1).map(evalNode); const ba = bboxOf(P); for (const b of rest) { tick(); if (b.length && overlap(ba, bboxOf(b))) P = C.subtract(P, b); } break; }
      case 'intersection': P = n.c.map(evalNode).reduce((a, b) => { tick(); return C.intersect(a, b); }); break;
      case 'color': P = evalNode(n.c[0]); break;
      case 'warp': case 'refine': case 'smooth': throw new Error(`${n.op === 'warp' ? 'bend() / warp()' : n.op + '()'} needs the fast 3D kernel (WebAssembly), which could not be loaded here`);
      case 'trim': { const nn = vec3(n.normal, 'normal'), l = Math.hypot(...nn) || 1, u = nn.map(x => x / l), big = 2000;
        const box = transform(evalNode({ op: 'cube', size: [big, big, big], center: true }), [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]]);
        const ax = Math.abs(u[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1], x = [u[1] * ax[2] - u[2] * ax[1], u[2] * ax[0] - u[0] * ax[2], u[0] * ax[1] - u[1] * ax[0]], xl = Math.hypot(...x), X = x.map(q => q / xl), Y = [u[1] * X[2] - u[2] * X[1], u[2] * X[0] - u[0] * X[2], u[0] * X[1] - u[1] * X[0]];
        const c = n.offset + big / 2, M = [[X[0], Y[0], u[0], u[0] * c], [X[1], Y[1], u[1], u[1] * c], [X[2], Y[2], u[2], u[2] * c]];
        P = C.intersect(evalNode(n.c[0]), transform(box, M)); break; }
      default: P = transform(evalNode(n.c[0]), matrixOf(n));
    }
    n._p = P;
    return P;
  }
  function tick() { if (budget && Date.now() > budget) throw new Error('Model too complex: took longer than the time limit. Use fewer segments (fn), fewer/lower-resolution spheres in hulls, or fewer boolean operations.'); }

  // ---------- fast kernel: Manifold (WASM, js/vendor) — exact booleans, always watertight, ~50× faster than the BSP
  // above, which stays as the fallback (no WASM, or Manifold refused an input). Same node tree, same results.
  let MF = null, MK = null;   // Manifold module; live Manifold objects of the current run (freed when it ends)
  function useManifold(m) { try { if (m && m.setup) m.setup(); MF = m && m.Manifold ? m : null; } catch (e) { MF = null; } return !!MF; }
  const kept = m => { MK.push(m); return m; };
  const xsec = s => kept(MF.CrossSection.ofPolygons(s.polys ? s.polys : [s.pts.map(q => [q[0], q[1]])], 'Positive'));
  const mat4 = M => [M[0][0], M[1][0], M[2][0], 0, M[0][1], M[1][1], M[2][1], 0, M[0][2], M[1][2], M[2][2], 0, M[0][3], M[1][3], M[2][3], 1];
  function spherePts(r, fn, c = [0, 0, 0]) {
    const rings = Math.max(2, Math.round(fn / 2)), out = [];
    for (let i = 0; i <= rings; i++) { const ph = Math.PI * i / rings; for (let k = 0; k < (i && i < rings ? fn : 1); k++) { const th = 2 * Math.PI * k / fn; out.push([c[0] + r * Math.sin(ph) * Math.cos(th), c[1] + r * Math.sin(ph) * Math.sin(th), c[2] + r * Math.cos(ph)]); } }
    return out;
  }
  function evalM(n) {
    if (n._m) return n._m;
    const { Manifold: M3, CrossSection: CS } = MF;
    let m;
    switch (n.op) {
      case 'cube': m = M3.cube(n.size, !!n.center); break;
      case 'cylinder': m = M3.cylinder(n.h, n.r1, n.r2, fnFor(Math.max(n.r1, n.r2), n.fn), !!n.center); break;
      case 'sphere': m = M3.sphere(n.r, fnFor(n.r, n.fn)); break;
      case 'torus': m = kept(kept(CS.circle(n.r, fnFor(n.r, n.fn2))).translate([n.R, 0])).revolve(fnFor(n.R + n.r, n.fn), 360); break;
      case 'extrude': m = xsec(n.shape).extrude(n.h, 0, 0, n.scale, false); if (n.center) m = kept(m).translate([0, 0, -n.h / 2]); break;
      case 'revolve':
        if (n.shape.pts.some(q => q[0] < -1e-9)) throw new Error('revolve(): the profile must lie at x ≥ 0 (x = distance from the Z axis, y = height)');
        m = xsec(n.shape).revolve(fnFor(Math.max(...n.shape.pts.map(q => q[0])), n.fn), n.angle); break;
      case 'roundedBox': {
        const [x, y, z] = n.size, r = n.r, o = n.center ? [0, 0, 0] : [x / 2, y / 2, z / 2], fn = fnFor(r, n.fn), pts = [];
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) pts.push(...spherePts(r, fn, [o[0] + sx * (x / 2 - r), o[1] + sy * (y / 2 - r), o[2] + sz * (z / 2 - r)]));
        m = M3.hull(pts); break;
      }
      case 'hull': m = M3.hull(n.c.map(evalM)); break;
      case 'rings': m = M3.hull(n.rings.flatMap(r => r.pts.map(q => [q[0], q[1], r.z]))); break;
      case 'union': m = M3.union(n.c.map(evalM)); break;
      case 'difference': m = M3.difference(n.c.map(evalM)); break;
      case 'intersection': m = M3.intersection(n.c.map(evalM)); break;
      case 'color': return (n._m = evalM(n.c[0]));
      case 'translate': m = evalM(n.c[0]).translate(n.v); break;
      case 'scale': m = evalM(n.c[0]).scale(n.v); break;
      case 'mirror': m = evalM(n.c[0]).mirror(n.v); break;
      case 'rotate': m = n.axis ? evalM(n.c[0]).transform(mat4(matrixOf(n))) : evalM(n.c[0]).rotate(n.v); break;
      case 'warp': m = evalM(n.c[0]).warp(n.fn); break;
      case 'refine': m = evalM(n.c[0]).refineToLength(n.len); break;
      case 'smooth': { const s = kept(evalM(n.c[0]).smoothOut(n.angle, n.smoothness)); m = s.refineToLength(n.len); break; }
      case 'trim': m = evalM(n.c[0]).trimByPlane(n.normal, n.offset); break;
      default: throw new Error('unsupported 3D operation ' + n.op);
    }
    return (n._m = kept(m));
  }
  // triangles of a Manifold as BSP polygons (vertices shared, so the rest of the pipeline works unchanged)
  function polysOfM(m) {
    const { V } = K(), g = m.getMesh(), np = g.numProp, P = g.vertProperties, T = g.triVerts, vs = new Array(P.length / np), out = [];
    for (let i = 0, k = 0; i < P.length; i += np, k++) vs[k] = new V(P[i], P[i + 1], P[i + 2]);
    for (let i = 0; i < T.length; i += 3) { const p = mk([vs[T[i]], vs[T[i + 1]], vs[T[i + 2]]]); if (p) out.push(p); }
    return out;
  }
  const mBounds = m => { const b = m.boundingBox(); return [b.min[0], b.min[1], b.min[2], b.max[0], b.max[1], b.max[2]]; };

  // OpenSCAD source of a node tree
  function scadOf(n, ind = '') {
    const i2 = ind + '  ', kids = () => n.c.map(c => scadOf(c, i2)).join('\n'), fnS = fn => fn || FN ? `, $fn=${fn || FN}` : '';
    switch (n.op) {
      case 'cube': return `${ind}cube(${fv(n.size)}${n.center ? ', center=true' : ''});`;
      case 'cylinder': return `${ind}cylinder(h=${f(n.h)}, r1=${f(n.r1)}, r2=${f(n.r2)}${n.center ? ', center=true' : ''}, $fn=${fnFor(Math.max(n.r1, n.r2), n.fn)});`;
      case 'sphere': return `${ind}sphere(r=${f(n.r)}, $fn=${fnFor(n.r, n.fn)});`;
      case 'torus': return `${ind}rotate_extrude($fn=${fnFor(n.R + n.r, n.fn)}) translate([${f(n.R)}, 0]) circle(r=${f(n.r)}, $fn=${fnFor(n.r, n.fn2)});`;
      case 'extrude': return `${ind}linear_extrude(height=${f(n.h)}${n.center ? ', center=true' : ''}${n.scale[0] !== 1 || n.scale[1] !== 1 ? `, scale=[${f(n.scale[0])}, ${f(n.scale[1])}]` : ''}) ${n.shape.scad()};`;
      case 'revolve': return `${ind}rotate_extrude(angle=${f(n.angle)}, $fn=${fnFor(Math.max(...n.shape.pts.map(q => q[0])), n.fn)}) ${n.shape.scad()};`;
      case 'roundedBox': { const [x, y, z] = n.size, r = n.r, o = n.center ? [0, 0, 0] : [x / 2, y / 2, z / 2]; return `${ind}hull() for (sx = [-1, 1], sy = [-1, 1], sz = [-1, 1]) translate([${f(o[0])} + sx * ${f(x / 2 - r)}, ${f(o[1])} + sy * ${f(y / 2 - r)}, ${f(o[2])} + sz * ${f(z / 2 - r)}]) sphere(r=${f(r)}, $fn=${fnFor(r, n.fn)});`; }
      case 'hull': case 'union': case 'difference': case 'intersection': return `${ind}${n.op}() {\n${kids()}\n${ind}}`;
      case 'rings': return `${ind}hull() {\n${n.rings.map(r => `${i2}translate([0, 0, ${f(r.z)}]) linear_extrude(height=0.01) polygon(${'[' + r.pts.map(q => `[${f(q[0])}, ${f(q[1])}]`).join(', ') + ']'});`).join('\n')}\n${ind}}`;
      case 'color': return `${ind}color("${n.col.replace(/"/g, '')}")\n${kids()}`;
      case 'warp': case 'refine': case 'smooth': return `${ind}// ${n.op}(): no OpenSCAD equivalent; the shape below is before it (the STL has it)\n${kids()}`;
      case 'trim': { const l = Math.hypot(...n.normal) || 1, u = n.normal.map(x => x / l), c = n.offset + 1000;
        return `${ind}intersection() {\n${kids()}\n${i2}translate(${fv(u.map(x => x * c))}) rotate(${fv([0, Math.acos(Math.max(-1, Math.min(1, u[2]))) * 180 / Math.PI, Math.atan2(u[1], u[0]) * 180 / Math.PI])}) cube(2000, center=true);\n${ind}}`; }
      case 'translate': return `${ind}translate(${fv(n.v)})\n${kids()}`;
      case 'scale': return `${ind}scale(${fv(n.v)})\n${kids()}`;
      case 'mirror': return `${ind}mirror(${fv(n.v)})\n${kids()}`;
      case 'rotate': return n.axis ? `${ind}rotate(a=${f(n.a)}, v=${fv(n.axis)})\n${kids()}` : `${ind}rotate(${fv(n.v)})\n${kids()}`;
    }
    return `${ind}// (unsupported node ${n.op})`;
  }

  // ---------- public builder API ----------
  const S = node => new Shape(node);
  function cube(size, o = {}) { const s = vec3(size, 'cube size'); if (s.some(v => v <= 0)) throw new Error('cube size must be > 0'); return S({ op: 'cube', size: s, center: !!o.center }); }
  function cylinder(o = {}) {
    if (typeof o !== 'object') throw new Error('cylinder({h, r | d, r1, r2, center, fn})');
    const r = o.r ?? (o.d != null ? o.d / 2 : 1), r1 = num(o.r1 ?? (o.d1 != null ? o.d1 / 2 : r), 'r1'), r2 = num(o.r2 ?? (o.d2 != null ? o.d2 / 2 : r), 'r2'), h = num(o.h ?? 1, 'h');
    if (h <= 0 || r1 < 0 || r2 < 0 || r1 + r2 <= 0) throw new Error('cylinder: h > 0 and a radius > 0 are required');
    return S({ op: 'cylinder', h, r1, r2, center: !!o.center, fn: o.fn });
  }
  function sphere(o = {}) { const r = typeof o === 'number' ? o : (o.r ?? (o.d != null ? o.d / 2 : 1)); return S({ op: 'sphere', r: num(r, 'r'), fn: typeof o === 'object' ? o.fn : undefined }); }
  function torus(o = {}) { return S({ op: 'torus', R: num(o.R ?? 10, 'R'), r: num(o.r ?? 2, 'r'), fn: o.fn, fn2: o.fn2 }); }
  function roundedBox(size, r = 2, o = {}) {
    const s = vec3(size, 'roundedBox size'); r = Math.min(num(r, 'radius'), ...s.map(v => v / 2 - 1e-3));
    if (r <= 0.01) return cube(s, o);
    return S({ op: 'roundedBox', size: s, r, center: o.center !== false, fn: o.fn });
  }
  function extrude(shape, h, o = {}) {
    if (typeof h === 'object') { o = h; h = o.h ?? o.height; }
    need2(shape, 'extrude'); h = num(h, 'height'); if (h <= 0) throw new Error('extrude height must be > 0');
    const sc = o.scale == null ? [1, 1] : typeof o.scale === 'number' ? [o.scale, o.scale] : [num(o.scale[0], 'scale'), num(o.scale[1] ?? o.scale[0], 'scale')];
    return S({ op: 'extrude', shape, h, center: !!o.center, scale: sc });
  }
  function revolve(shape, o = {}) { need2(shape, 'revolve'); const angle = Math.max(1, Math.min(360, num(o.angle ?? 360, 'angle'))); return S({ op: 'revolve', shape, angle, fn: o.fn }); }
  const hull = (...s) => S({ op: 'hull', c: list(s, 'hull') });
  function union(...s) { const c = list(s, 'union'); if (!c.length) throw new Error('union() of nothing'); return c.length === 1 ? S(c[0]) : S({ op: 'union', c }); }
  function difference(a, ...s) { const c = list([a, ...s], 'difference'); return c.length === 1 ? S(c[0]) : S({ op: 'difference', c }); }
  function intersection(...s) { const c = list(s, 'intersection'); return c.length === 1 ? S(c[0]) : S({ op: 'intersection', c }); }

  // ---------- manufacturability: wall thickness, knife edges, narrow gaps, lid fit, openings (leaks) ----------
  // Measured on the triangles like a print service's heatmap: from points spread over every face, a ray goes straight
  // into the material; where it comes out is the local thickness. Only exits through a roughly opposite face count
  // (a ray leaving through a side face is a corner, not a thin wall). Openings: rays from the air inside the case
  // that get out — a gap in a wall shows up even where no part box is.
  // globals as locals: inside Node's vm (the MCP server) every global lookup in a hot loop is slow
  const MathL = Math, INF = Infinity, nowL = () => Date.now();
  const PROCESSES = {
    mjf: { name: 'MJF nylon (PA12 / PA11)', wall: 1.0, hole: 1.0, gap: 0.5, fit: 0.3, minBox: [2, 2, 10] },   // JLC3DP refuses smaller parts
    sls: { name: 'SLS nylon (PA12)', wall: 1.0, hole: 1.0, gap: 0.5, fit: 0.3, minBox: [2, 2, 10] },
    sla: { name: 'SLA resin', wall: 0.8, hole: 0.6, gap: 0.3, fit: 0.2 },
    fdm: { name: 'FDM (PLA / PETG)', wall: 1.2, hole: 1.5, gap: 0.4, fit: 0.3 },
  };
  // bounding-volume tree over flat triangle data (9 numbers per triangle), in typed arrays: node k has its box at
  // box[6k…6k+5]; inner nodes: left child k+1, right child right[k]; leaves: triangles ids[start[k] … start[k]+count[k])
  function bvh(T) {
    const n = T.length / 9, ids = new Int32Array(n), c = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) { ids[i] = i; for (let k = 0; k < 3; k++) c[i * 3 + k] = (T[i * 9 + k] + T[i * 9 + 3 + k] + T[i * 9 + 6 + k]) / 3; }
    const cap = 2 * n + 2, box = new Float64Array(cap * 6), right = new Int32Array(cap), start = new Int32Array(cap), count = new Int32Array(cap);
    let nn = 0;
    const st = [[0, n, -1]];   // [a, b, parent] — a node is written when popped; its right child index is patched later
    while (st.length) {
      const [a, b, par] = st.pop(), k = nn++;
      if (par >= 0) right[par] = k;
      let x0 = INF, y0 = INF, z0 = INF, x1 = -INF, y1 = -INF, z1 = -INF;
      for (let j = a; j < b; j++) { const o = ids[j] * 9; for (let v = 0; v < 9; v += 3) { const x = T[o + v], y = T[o + v + 1], z = T[o + v + 2]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z; } }
      box[k * 6] = x0; box[k * 6 + 1] = y0; box[k * 6 + 2] = z0; box[k * 6 + 3] = x1; box[k * 6 + 4] = y1; box[k * 6 + 5] = z1;
      if (b - a <= 4) { start[k] = a; count[k] = b - a; continue; }
      const ax = x1 - x0 >= y1 - y0 && x1 - x0 >= z1 - z0 ? 0 : y1 - y0 >= z1 - z0 ? 1 : 2, mid = (a + b) >> 1;
      // partition around the median along the axis (quickselect, in place)
      for (let lo = a, hi = b - 1; lo < hi;) {
        const pv = c[ids[(lo + hi) >> 1] * 3 + ax]; let i = lo, j = hi;
        while (i <= j) { while (c[ids[i] * 3 + ax] < pv) i++; while (c[ids[j] * 3 + ax] > pv) j--; if (i <= j) { const q = ids[i]; ids[i] = ids[j]; ids[j] = q; i++; j--; } }
        if (mid <= j) hi = j; else if (mid >= i) lo = i; else break;
      }
      count[k] = 0;
      st.push([mid, b, k], [a, mid, -1]);   // left (popped next) lands at k + 1
    }
    return { T, ids, box, right, start, count };
  }
  // nearest hit of a ray (o, d) beyond tMin; all = count every crossing instead (inside / outside test)
  function cast(B, o, d, tMin = 1e-6, skip = -1, all = false, tMax = INF) {
    const T = B.T, ids = B.ids, bx = B.box, right = B.right, start = B.start, count = B.count;
    const ox = o[0], oy = o[1], oz = o[2], dx = d[0], dy = d[1], dz = d[2], ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
    let best = tMax, bi = -1, hits = 0, sp = 0;   // hits farther than tMax do not matter to the caller
    const st = cast.stack || (cast.stack = new Int32Array(256));
    st[sp++] = 0;
    while (sp) {
      const k = st[--sp], q6 = k * 6;
      let t0 = -INF, t1 = INF;
      if (dx === 0) { if (ox < bx[q6] || ox > bx[q6 + 3]) continue; } else { let a = (bx[q6] - ox) * ix, b = (bx[q6 + 3] - ox) * ix; if (a > b) { const q = a; a = b; b = q; } t0 = a; t1 = b; }
      if (dy === 0) { if (oy < bx[q6 + 1] || oy > bx[q6 + 4]) continue; } else { let a = (bx[q6 + 1] - oy) * iy, b = (bx[q6 + 4] - oy) * iy; if (a > b) { const q = a; a = b; b = q; } if (a > t0) t0 = a; if (b < t1) t1 = b; }
      if (dz === 0) { if (oz < bx[q6 + 2] || oz > bx[q6 + 5]) continue; } else { let a = (bx[q6 + 2] - oz) * iz, b = (bx[q6 + 5] - oz) * iz; if (a > b) { const q = a; a = b; b = q; } if (a > t0) t0 = a; if (b < t1) t1 = b; }
      if (t1 < (t0 > tMin ? t0 : tMin) || (!all && t0 > best)) continue;
      const n = count[k];
      if (!n) {   // nearer child last on the stack, so it is searched first and the far one is mostly skipped
        const l = k + 1, r = right[k];
        if (all) { st[sp++] = r; st[sp++] = l; continue; }
        const near = (q) => { const b = q * 6; let a0 = dx === 0 ? -INF : MathL.min((bx[b] - ox) * ix, (bx[b + 3] - ox) * ix); if (dy !== 0) a0 = MathL.max(a0, MathL.min((bx[b + 1] - oy) * iy, (bx[b + 4] - oy) * iy)); if (dz !== 0) a0 = MathL.max(a0, MathL.min((bx[b + 2] - oz) * iz, (bx[b + 5] - oz) * iz)); return a0; };
        if (near(l) <= near(r)) { st[sp++] = r; st[sp++] = l; } else { st[sp++] = l; st[sp++] = r; }
        continue;
      }
      for (let j = start[k], e = start[k] + n; j < e; j++) {
        const i = ids[j]; if (i === skip) continue; const q = i * 9;
        const e1x = T[q + 3] - T[q], e1y = T[q + 4] - T[q + 1], e1z = T[q + 5] - T[q + 2], e2x = T[q + 6] - T[q], e2y = T[q + 7] - T[q + 1], e2z = T[q + 8] - T[q + 2];
        const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x, det = e1x * px + e1y * py + e1z * pz;
        if (det < 1e-12 && det > -1e-12) continue;
        const iv = 1 / det, sx = ox - T[q], sy = oy - T[q + 1], sz = oz - T[q + 2], u = (sx * px + sy * py + sz * pz) * iv; if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x, v = (dx * qx + dy * qy + dz * qz) * iv; if (v < 0 || u + v > 1) continue;
        const t = (e2x * qx + e2y * qy + e2z * qz) * iv;
        if (t > tMin) { if (all) hits++; else if (t < best) { best = t; bi = i; } }
      }
    }
    return all ? hits : bi < 0 ? null : { t: best, i: bi };
  }
  function triNormal(T, i) { const q = i * 9, ax = T[q + 3] - T[q], ay = T[q + 4] - T[q + 1], az = T[q + 5] - T[q + 2], bx = T[q + 6] - T[q], by = T[q + 7] - T[q + 1], bz = T[q + 8] - T[q + 2]; const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx, l = MathL.hypot(nx, ny, nz) || 1; return [nx / l, ny / l, nz / l, l / 2]; }
  // flat triangle data; long triangles (the slivers across flat caps) are cut in two at their longest edge until no
  // edge is over maxEdge mm, so their boxes stay small and a ray tests few of them. orig = the source triangle
  function flat(tris, maxEdge = 3) {
    const out = [], orig = [], st = [];
    tris.forEach(([a, b, c], i) => st.push([[a.x, a.y, a.z], [b.x, b.y, b.z], [c.x, c.y, c.z], i]));
    while (st.length) {
      const [a, b, c, i] = st.pop(), l = [[a, b, c], [b, c, a], [c, a, b]].map(([p, q, r]) => [MathL.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]), p, q, r]).sort((x, y) => y[0] - x[0])[0];
      if (l[0] <= maxEdge || out.length > 600000) { out.push(...a, ...b, ...c); orig.push(i); continue; }
      const [, p, q, r] = l, m = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
      st.push([p, m, r, i], [m, q, r, i]);
    }
    return { T: new Float64Array(out), orig };
  }
  // group nearby points (cell grid) → clusters with their worst value, area and centre
  function clusters(pts, cell = 1.5) {
    const par = pts.map((_, i) => i), find = i => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; }, g = new Map(), k = (x, y, z) => x + ',' + y + ',' + z;
    pts.forEach((p, i) => { const c = p.at.map(v => MathL.floor(v / cell)); for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let d = -1; d <= 1; d++) for (const j of g.get(k(c[0] + a, c[1] + b, c[2] + d)) || []) if (MathL.hypot(pts[j].at[0] - p.at[0], pts[j].at[1] - p.at[1], pts[j].at[2] - p.at[2]) < cell) par[find(i)] = find(j); const key = k(...c); if (!g.has(key)) g.set(key, []); g.get(key).push(i); });
    const out = new Map();
    pts.forEach((p, i) => { const r = find(i); let c = out.get(r); if (!c) out.set(r, c = { part: p.part, min: INF, area: 0, n: 0, s: [0, 0, 0], lo: [INF, INF, INF], hi: [-INF, -INF, -INF] }); c.min = MathL.min(c.min, p.v); c.area += p.area || 0; c.n++; for (let a = 0; a < 3; a++) { c.s[a] += p.at[a]; c.lo[a] = MathL.min(c.lo[a], p.at[a]); c.hi[a] = MathL.max(c.hi[a], p.at[a]); } });
    return [...out.values()].map(c => ({ part: c.part, min: c.min, area: c.area, at: c.s.map(v => +(v / c.n).toFixed(2)), size: c.lo.map((v, a) => +(c.hi[a] - v).toFixed(2)) }));
  }
  // parts: [{name, polys, print}], pcb (script context) for the openings, expected openings (ports, windows)
  function dfmCheck(parts, o = {}) {
    // the project's rules (set_enclosure {rules}) make the process limits stricter, never looser
    const R0 = PROCESSES[o.process] || PROCESSES.mjf, ru = o.rules || {}, P = Object.assign({}, R0, { wall: Math.max(R0.wall, +ru.minWall || 0), fit: Math.max(R0.fit, +ru.fit || 0), minBox: ru.minPart || R0.minBox });
    const t0 = nowL(), deadline = t0 + (o.timeMs || 6000), res = { process: o.process || 'mjf', rules: P, thin: [], knife_edges: [], narrow_gaps: [], fit: [], openings: [] };
    const printed = parts.filter(p => !p.noPrint);
    const Fs = printed.map(p => flat(K().triangles(p.polys))), Ts = Fs.map(f => f.T), Bs = Ts.map(bvh);
    const OsF = printed.map(p => flat(K().triangles(p.polys), INF)), Os = OsF.map(f => f.T);   // the mesh as built: shared edges intact (edge checks); orig = index in the part's triangles
    const allT = new Float64Array(Ts.reduce((a, T) => a + T.length, 0)), owner = []; { let off = 0; Ts.forEach((T, j) => { allT.set(T, off); for (let i = 0; i < T.length / 9; i++) owner.push(j); off += T.length; }); }
    const BA = bvh(allT);
    // samples: about one per (spacing)² mm² of surface, at most `cap` in all
    const area = Ts.reduce((a, T) => { let s = 0; for (let i = 0; i < T.length / 9; i++) s += triNormal(T, i)[3]; return a + s; }, 0);
    const sp = MathL.max(o.spacing || 0.6, MathL.sqrt(area / (o.cap || 20000)));
    const thin = [], gaps = [], lips = [], fitMin = new Map();
    printed.forEach((p, j) => {
      const T = Ts[j], B = Bs[j], nT = T.length / 9, orig = Fs[j].orig, thick = new Float32Array(K().triangles(p.polys).length).fill(INF);
      // sharp edges (the faces turn by 70° or more), on a 1 mm grid: a short ray next to one is a rim or a corner, not a thin wall
      const sharp = new Map(), sk = (x, y, z) => MathL.floor(x) + ',' + MathL.floor(y) + ',' + MathL.floor(z);
      { const T = Os[j], nT = T.length / 9, em = new Map(), vk = (q, v) => `${MathL.round(T[q + v] * 1e3)},${MathL.round(T[q + v + 1] * 1e3)},${MathL.round(T[q + v + 2] * 1e3)}`;
        for (let i = 0; i < nT; i++) { const q = i * 9; for (const [v1, v2] of [[0, 3], [3, 6], [6, 0]]) { const a = vk(q, v1), b = vk(q, v2), k = a < b ? a + '|' + b : b + '|' + a, e = em.get(k); if (!e) em.set(k, { i, v1, v2 }); else e.j = i; } }
        for (const e of em.values()) {
          if (e.j == null) continue; const n1 = triNormal(T, e.i), n2 = triNormal(T, e.j);
          if (n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2] > 0.342) continue;
          const q = e.i * 9, A = [T[q + e.v1], T[q + e.v1 + 1], T[q + e.v1 + 2]], Bp = [T[q + e.v2], T[q + e.v2 + 1], T[q + e.v2 + 2]], L = MathL.hypot(Bp[0] - A[0], Bp[1] - A[1], Bp[2] - A[2]);
          for (let s2 = 0; s2 <= L; s2 += 0.5) { const f = L ? s2 / L : 0, c = sk(A[0] + (Bp[0] - A[0]) * f, A[1] + (Bp[1] - A[1]) * f, A[2] + (Bp[2] - A[2]) * f); if (!sharp.has(c)) sharp.set(c, []); const lst = sharp.get(c); if (lst[lst.length - 1] !== e) lst.push([A, Bp]); }
        }
      }
      const nearSharp = (x, y, z) => {
        for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) for (const [A, Bp] of sharp.get(sk(x + a, y + b, z + c)) || []) {
          const dx = Bp[0] - A[0], dy = Bp[1] - A[1], dz = Bp[2] - A[2], l2 = dx * dx + dy * dy + dz * dz, t = l2 ? MathL.max(0, MathL.min(1, ((x - A[0]) * dx + (y - A[1]) * dy + (z - A[2]) * dz) / l2)) : 0;
          if (MathL.hypot(x - A[0] - dx * t, y - A[1] - dy * t, z - A[2] - dz * t) < 0.3) return true;
        }
        return false;
      };
      let seq = 0;
      const TO = Os[j], nO = TO.length / 9, oIdx = OsF[j].orig, smp = [];   // samples: x, y, z, thickness, normal (heatmap, size labels)
      for (let i = 0; i < nO && nowL() < deadline; i++) {
        const [nx, ny, nz, A] = triNormal(TO, i); if (A < 1e-6) continue;
        const m = MathL.max(1, MathL.round(A / (sp * sp))), q = i * 9;
        for (let s = 0; s < m; s++, seq++) {
          let a = 1 / 3, b = 1 / 3;
          if (m > 1) { const r1 = (seq * 0.6180339887) % 1, r2 = (seq * 0.7548776662 + 0.5) % 1, u = MathL.sqrt(r1); a = 1 - u; b = u * (1 - r2); }
          const c = 1 - a - b;
          const x = a * TO[q] + b * TO[q + 3] + c * TO[q + 6], y = a * TO[q + 1] + b * TO[q + 4] + c * TO[q + 7], z = a * TO[q + 2] + b * TO[q + 5] + c * TO[q + 8];
          // into the material
          const h = cast(B, [x - nx * 1e-5, y - ny * 1e-5, z - nz * 1e-5], [-nx, -ny, -nz], 1e-6, -1, false, 4);   // thicker than 4 mm: fine
          if (h) {
            const hn = triNormal(T, h.i);
            if (hn[0] * nx + hn[1] * ny + hn[2] * nz < -0.5) {
              // next to a sharp edge a short ray may be a corner — kept apart as an "edge lip" (a strip of them is real: where a
              // curved underside meets an end cut, the print service flags it as a thin wall)
              thick[oIdx[i]] = MathL.min(thick[oIdx[i]], h.t); smp.push(x, y, z, h.t, nx, ny, nz);
              if (h.t < P.wall) { const ns = nearSharp(x, y, z); if (!ns || h.t >= 0.08) (ns ? lips : thin).push({ part: p.name, v: h.t, area: A / m, at: [x, y, z] }); }
            }
          }
          // out into the air: a narrow slit inside one part (fuses / traps powder), or the clearance to another part
          const g = cast(BA, [x + nx * 1e-5, y + ny * 1e-5, z + nz * 1e-5], [nx, ny, nz], 1e-6, -1, false, MathL.max(P.gap, P.fit) * 1.5);
          if (g && g.t < MathL.max(P.gap, P.fit) * 1.5) {
            const hn = triNormal(allT, g.i), other = owner[g.i];
            if (hn[0] * nx + hn[1] * ny + hn[2] * nz < -0.5) {
              if (other === j) { if (g.t < P.gap) gaps.push({ part: p.name, v: g.t, area: A / m, at: [x, y, z] }); }
              else if (g.t > 0.02) { const key = [p.name, printed[other].name].sort().join(' ↔ '); const f = fitMin.get(key); if (!f || g.t < f.v) fitMin.set(key, { v: g.t, at: [x, y, z] }); }
            }
          }
        }
      }
      p.thick = thick; p.samples = new Float32Array(smp);
      // knife edges: two faces meeting at a convex edge sharper than 30°
      const T2 = Os[j], nT2 = T2.length / 9, em = new Map(), key = (q, v) => `${MathL.round(T2[q + v] * 1e3)},${MathL.round(T2[q + v + 1] * 1e3)},${MathL.round(T2[q + v + 2] * 1e3)}`, knives = [];
      for (let i = 0; i < nT2; i++) { const q = i * 9; for (const [v1, v2, v3] of [[0, 3, 6], [3, 6, 0], [6, 0, 3]]) { const k1 = key(q, v1), k2 = key(q, v2), k = k1 < k2 ? k1 + '|' + k2 : k2 + '|' + k1, e = em.get(k); if (!e) em.set(k, { i, o: v3, a: v1, b: v2 }); else if (e.j == null) { e.j = i; e.oj = v3; } } }
      for (const e of em.values()) {
        if (e.j == null) continue;
        const n1 = triNormal(T2, e.i), n2 = triNormal(T2, e.j), cos = n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2];
        if (cos > -0.866 || cos < -0.99985) continue;   // faces meet at more than 30°, or fold flat back (< 1°: a zero-thickness mesh fin, not a part edge)
        const q1 = e.i * 9, q2 = e.j * 9, ox = T2[q2 + e.oj] - T2[q1 + e.a], oy = T2[q2 + e.oj + 1] - T2[q1 + e.a + 1], oz = T2[q2 + e.oj + 2] - T2[q1 + e.a + 2];
        if (n1[0] * ox + n1[1] * oy + n1[2] * oz > 0) continue;   // concave (a groove), not an edge
        const ax = T2[q1 + e.a], ay = T2[q1 + e.a + 1], az = T2[q1 + e.a + 2], bx = T2[q1 + e.b], by = T2[q1 + e.b + 1], bz = T2[q1 + e.b + 2];
        knives.push({ part: p.name, v: 180 - MathL.acos(MathL.max(-1, MathL.min(1, cos))) * 180 / MathL.PI, area: MathL.hypot(bx - ax, by - ay, bz - az), at: [(ax + bx) / 2, (ay + by) / 2, (az + bz) / 2] });
      }
      res.knife_edges.push(...clusters(knives, 1.0).filter(c => c.area > 0.3).map(c => ({ part: c.part, angle_deg: +c.min.toFixed(0), length_mm: +c.area.toFixed(1), at: c.at })));
    });
    // a near-edge sample next to an ordinary thin wall is that wall's edge (already reported): dropped, not a lip
    { const g = new Map(), k = (x, y, z) => MathL.floor(x / 1.5) + ',' + MathL.floor(y / 1.5) + ',' + MathL.floor(z / 1.5);
      for (const t of thin) g.set(t.part + k(...t.at), true);
      for (let i = lips.length - 1; i >= 0; i--) { const l = lips[i], [x, y, z] = l.at; let near = false;
        for (let a = -1; a <= 1 && !near; a++) for (let b = -1; b <= 1 && !near; b++) for (let c = -1; c <= 1 && !near; c++) near = g.has(l.part + k(x + a * 1.5, y + b * 1.5, z + c * 1.5));
        if (near) lips.splice(i, 1); } }
    const tc = clusters(thin, 1.5).filter(c => c.area > 0.05).sort((a, b) => a.min - b.min);
    // the feature each thin spot belongs to (engraving, recess, rib …), and what to change
    const featOf = at => (o.features || []).find(ft => ft.box && at[0] >= ft.box[0] - 1 && at[0] <= ft.box[3] + 1 && at[1] >= ft.box[1] - 1 && at[1] <= ft.box[4] + 1 && at[2] >= ft.box[2] - 1 && at[2] <= ft.box[5] + 1);
    res.thin = tc.map(c => {
      const ft = featOf(c.at), out = { part: c.part, min_mm: +c.min.toFixed(2), area_mm2: +c.area.toFixed(1), at: c.at, size: c.size };
      if (ft) {
        out.feature = `${ft.kind}${ft.name ? ' "' + ft.name + '"' : ''}`;
        const short = P.wall - c.min;
        out.fix = ft.depth != null ? (ft.depth - short >= 0.2 ? `make it ${(ft.depth - short).toFixed(2)} mm deep (now ${ft.depth}) — leaves ${P.wall} mm behind it` : `thicken the wall behind it by ${short.toFixed(2)} mm, or make it shallower`)
          : ft.width != null ? `make it ${P.wall} mm wide (now ~${c.min.toFixed(2)})` : `thicken it by ${short.toFixed(2)} mm`;
      }
      return out;
    });
    // lips: strips along an edge (≥ 2 mm² together); a lone corner sample is not one
    res.edge_lips = clusters(lips, 1.5).filter(c => c.area >= 2).sort((a, b) => a.min - b.min).map(c => ({ part: c.part, min_mm: +c.min.toFixed(2), area_mm2: +c.area.toFixed(1), at: c.at.map(v => +v.toFixed(2)) }));
    res.narrow_gaps = clusters(gaps, 1.5).filter(c => c.area > 0.05).map(c => ({ part: c.part, gap_mm: +c.min.toFixed(2), area_mm2: +c.area.toFixed(1), at: c.at }));
    // F8: the service's smallest printable part (sorted sizes against the process box)
    res.too_small = [];
    if (P.minBox) for (const p of printed) { const b = bboxOf(p.polys), sz = [b[3] - b[0], b[4] - b[1], b[5] - b[2]].sort((a, c) => a - c), mb = P.minBox.slice().sort((a, c) => a - c); if (sz.some((v, i) => v < mb[i] - 1e-6)) res.too_small.push({ part: p.name, size_mm: sz.map(v => +v.toFixed(2)), min_mm: mb }); }
    for (const [k, f] of fitMin) res.fit.push({ parts: k, clearance_mm: +f.v.toFixed(2), at: f.at.map(v => +v.toFixed(2)), ok: f.v >= P.fit - 1e-3 });
    // openings: from points in the air around the board, rays in 26 directions; those that get out mark a hole
    if (o.pcb && nowL() < deadline) {
      const pcb = o.pcb, xs = pcb.outline.map(q => q[0]), ys = pcb.outline.map(q => q[1]);
      const zLo = MathL.min(0, ...pcb.parts.filter(q => q.side === 'bottom').map(q => -q.h)) - 0.6, zHi = pcb.thickness + MathL.max(0.5, ...pcb.parts.filter(q => q.side === 'top').map(q => q.h)) + 0.6;
      const sh = o.shift || [0, 0, 0];   // the board region in the parts' coordinates
      const lo = [MathL.min(...xs) - 1 + sh[0], MathL.min(...ys) - 1 + sh[1], zLo + sh[2]], hi = [MathL.max(...xs) + 1 + sh[0], MathL.max(...ys) + 1 + sh[1], zHi + sh[2]];
      const bb = [INF, INF, INF, -INF, -INF, -INF]; for (let i = 0; i < allT.length; i += 3) for (let k = 0; k < 3; k++) { bb[k] = MathL.min(bb[k], allT[i + k]); bb[k + 3] = MathL.max(bb[k + 3], allT[i + k]); }
      const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
      const step = MathL.max(0.8, MathL.cbrt((hi[0] - lo[0]) * (hi[1] - lo[1]) * (hi[2] - lo[2]) / (o.openPts || 2500))), esc = [];
      for (let x = lo[0]; x <= hi[0]; x += step) for (let y = lo[1]; y <= hi[1]; y += step) for (let z = lo[2]; z <= hi[2]; z += MathL.min(step, (hi[2] - lo[2]) / 3)) {
        if (nowL() > deadline) break;
        const Pt = [x, y, z];
        if (cast(BA, Pt, [0.0013, 0.0021, 1], 1e-6, -1, true) % 2) continue;   // inside the material
        // air inside the case sees out at most two ways, and never straight through along one axis (outside air does)
        const free = dirs.map(d => !cast(BA, Pt, d));
        if (free.filter(Boolean).length > 2 || (free[0] && free[1]) || (free[2] && free[3]) || (free[4] && free[5])) continue;
        for (const [di, d] of dirs.entries()) if (free[di]) {
          // where the ray leaves the case's box: that face and spot
          let tx = INF, face = null;
          for (let k = 0; k < 3; k++) if (d[k]) { const t = ((d[k] > 0 ? bb[k + 3] : bb[k]) - Pt[k]) / d[k]; if (t < tx) { tx = t; face = [['left', 'right'], ['front', 'back'], ['bottom', 'top']][k][d[k] > 0 ? 1 : 0]; } }
          esc.push({ face, at: Pt.map((v, k) => v + d[k] * tx), from: Pt });
        }
      }
      for (const face of ['left', 'right', 'front', 'back', 'top', 'bottom']) {
        const L = esc.filter(e => e.face === face).map(e => ({ part: face, v: 0, at: e.at }));
        for (const c of clusters(L, 4)) {
          const exp = (o.expected || []).find(x => x.side === face && MathL.hypot(...c.at.map((v, k) => k === { left: 0, right: 0, front: 1, back: 1, top: 2, bottom: 2 }[face] ? 0 : v - x.at[k])) < (x.r || 6));
          res.openings.push({ side: face, at: c.at, size_mm: c.size.filter((_, k) => k !== { left: 0, right: 0, front: 1, back: 1, top: 2, bottom: 2 }[face]), expected: exp ? exp.what : null });
        }
      }
    }
    res.ms = nowL() - t0;
    if (nowL() > deadline) res.note = 'stopped early (time limit): results are partial';
    return res;
  }

  // ---------- exchange formats: STEP (solids) and DXF (cut lines) — for JLCCNC sheet parts and JLC3DP ----------
  const stepNum = v => { const s = (+v).toFixed(6).replace(/0+$/, ''); return s.endsWith('.') ? s : s.includes('.') ? s : s + '.'; };
  const stepStr = s => "'" + String(s).replace(/'/g, "''").replace(/[^\x20-\x7e]/g, '_') + "'";
  // a faceted solid (FACETED_BREP, AP214): faces = [[outer loop], [hole loop], …] with [x, y, z] points
  // the product / units / context entities every STEP part needs; returns the context and the shape-definition owner
  function productHead(name, add) {
    const ctx1 = add("APPLICATION_CONTEXT('automotive design')");
    add(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,${ctx1})`);
    const pc = add(`PRODUCT_CONTEXT('',${ctx1},'mechanical')`), pr = add(`PRODUCT(${stepStr(name)},${stepStr(name)},'',(${pc}))`);
    const pdf = add(`PRODUCT_DEFINITION_FORMATION('','',${pr})`), pdc = add(`PRODUCT_DEFINITION_CONTEXT('part definition',${ctx1},'design')`);
    const pd = add(`PRODUCT_DEFINITION('design','',${pdf},${pdc})`), pds = add(`PRODUCT_DEFINITION_SHAPE('','',${pd})`);
    const lu = add('(LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.))'), au = add('(NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.))'), su = add('(NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT())');
    const um = add(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-04),${lu},'distance_accuracy_value','')`);
    const ctx = add(`(GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${um})) GLOBAL_UNIT_ASSIGNED_CONTEXT((${lu},${au},${su})) REPRESENTATION_CONTEXT('',''))`);
    return { ctx, pds };
  }
  function stepFile(name, L) {
    const now = new Date().toISOString().slice(0, 19);
    return ['ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION(('CircuitPilot enclosure part'),'2;1');", `FILE_NAME(${stepStr(name + '.step')},'${now}',('CircuitPilot'),(''),'CircuitPilot','CircuitPilot','');`,
      "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));", 'ENDSEC;', 'DATA;', ...L.map((e, i) => `#${i + 1}=${e};`), 'ENDSEC;', 'END-ISO-10303-21;', ''].join('\n');
  }
  function stepOf(name, faces) {
    const L = [], add = e => { L.push(e); return '#' + L.length; }, pts = new Map();
    // a point is one entity per mesh vertex (q[3] = its id) — merging by rounded coordinates would join distinct vertices
    // closer than the rounding and leave edges with more than two faces (no closed solid)
    const pt = q => { const k = q.length > 3 ? '#' + q[3] : q.map(v => (+v).toFixed(7)).join(','); if (!pts.has(k)) pts.set(k, add(`CARTESIAN_POINT('',(${q.slice(0, 3).map(stepNum).join(',')}))`)); return pts.get(k); };
    const { ctx: gc, pds } = productHead(name, add);
    const fs = [];
    for (const loops of faces) {
      const outer = loops[0]; if (!outer || outer.length < 3) continue;
      // the face's plane (Newell normal of the outer loop): CAD readers build a face only on a surface
      let nx = 0, ny = 0, nz = 0; for (let i = 0; i < outer.length; i++) { const a = outer[i], b = outer[(i + 1) % outer.length]; nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1]); }
      const nl = Math.hypot(nx, ny, nz); if (nl < 1e-18) continue; nx /= nl; ny /= nl; nz /= nl;
      const rx = Math.abs(nx) < 0.9 ? [1, 0, 0] : [0, 1, 0], d = rx[0] * nx + rx[1] * ny + rx[2] * nz, ref = [rx[0] - d * nx, rx[1] - d * ny, rx[2] - d * nz], rl = Math.hypot(...ref);
      const pl = add(`PLANE('',${add(`AXIS2_PLACEMENT_3D('',${pt(outer[0])},${add(`DIRECTION('',(${[nx, ny, nz].map(stepNum).join(',')}))`)},${add(`DIRECTION('',(${ref.map(v => stepNum(v / rl)).join(',')}))`)})`)})`);
      const bounds = loops.filter(l => l.length >= 3).map((l, i) => add(`${i ? 'FACE_BOUND' : 'FACE_OUTER_BOUND'}('',${add(`POLY_LOOP('',(${l.map(pt).join(',')}))`)},.T.)`));
      fs.push(add(`FACE_SURFACE('',(${bounds.join(',')}),${pl},.T.)`));
    }
    const sh = add(`CLOSED_SHELL('',(${fs.join(',')}))`), br = add(`FACETED_BREP(${stepStr(name)},${sh})`);
    const o = add("CARTESIAN_POINT('',(0.,0.,0.))"), ax = add(`AXIS2_PLACEMENT_3D('',${o},${add("DIRECTION('',(0.,0.,1.))")},${add("DIRECTION('',(1.,0.,0.))")})`);
    const rep = add(`FACETED_BREP_SHAPE_REPRESENTATION(${stepStr(name)},(${br},${ax}),${gc})`);
    add(`SHAPE_DEFINITION_REPRESENTATION(${pds},${rep})`);
    return stepFile(name, L);
  }
  // ---------- exact 2D profiles for sheet parts: lines, arcs and circles (never polygonised) ----------
  // A loop is a list of segments, each starting where the previous one ends:
  //   {t: 'L', a: [x, y], b: [x, y]}   or   {t: 'A', c: [x, y], r, a0, a1, ccw}  (angles in radians, a1 reached from a0 going ccw / cw)
  // Outer loops run counter-clockwise, holes clockwise (material on the left of the travel direction).
  // JLCCNC (and most laser shops) quote such files automatically; hundreds of tiny segments go to a manual quote.
  const TAU = Math.PI * 2;
  const P = {
    pt: (s, end) => s.t === 'L' ? (end ? s.b : s.a) : [s.c[0] + s.r * Math.cos(end ? s.a1 : s.a0), s.c[1] + s.r * Math.sin(end ? s.a1 : s.a0)],
    sweep: s => { let d = s.ccw ? s.a1 - s.a0 : s.a0 - s.a1; while (d <= 1e-12) d += TAU; return Math.min(d, TAU); },
    len: s => s.t === 'L' ? Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]) : s.r * P.sweep(s),
    rect(w, h, r = 0, cx = 0, cy = 0) {
      // a pill (r within 0.05 mm of half the short side) is exactly two half circles and two straights: no 0.002 mm lines
      r = Math.max(0, Math.min(r, w / 2, h / 2)); if (Math.min(w, h) / 2 - r < 0.05) r = Math.min(w, h) / 2;
      if (r > 0 && Math.abs(w - h) < 1e-9 && r >= w / 2 - 1e-9) return P.circle(r, cx, cy); const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2, L = [], q = Math.PI / 2;
      if (r < 1e-6) return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map((a, i, A) => ({ t: 'L', a, b: A[(i + 1) % 4] }));
      L.push({ t: 'L', a: [x0 + r, y0], b: [x1 - r, y0] }, { t: 'A', c: [x1 - r, y0 + r], r, a0: -q, a1: 0, ccw: true });
      L.push({ t: 'L', a: [x1, y0 + r], b: [x1, y1 - r] }, { t: 'A', c: [x1 - r, y1 - r], r, a0: 0, a1: q, ccw: true });
      L.push({ t: 'L', a: [x1 - r, y1], b: [x0 + r, y1] }, { t: 'A', c: [x0 + r, y1 - r], r, a0: q, a1: 2 * q, ccw: true });
      L.push({ t: 'L', a: [x0, y1 - r], b: [x0, y0 + r] }, { t: 'A', c: [x0 + r, y0 + r], r, a0: 2 * q, a1: 3 * q, ccw: true });
      return P.clean(L);
    },
    // drop segments shorter than 0.01 mm (they make zero-length DXF lines and sliver STEP faces); lines take the previous end
    clean(L) {
      const out = L.filter(s => P.len(s) >= 0.01); if (!out.length) return L.slice();
      for (let i = 0; i < out.length; i++) { const s = out[i], prev = P.pt(out[(i - 1 + out.length) % out.length], true); if (s.t === 'L' && Math.hypot(s.a[0] - prev[0], s.a[1] - prev[1]) > 0) out[i] = { t: 'L', a: prev.slice(), b: s.b }; }
      return out;
    },
    // the widest gap between one segment's end and the next one's start (0 = the loop closes)
    gapOf(L, closed = true) { let g = 0; for (let i = 0; i < L.length - (closed ? 0 : 1); i++) { const a = P.pt(L[i], true), b = P.pt(L[(i + 1) % L.length], false); g = Math.max(g, Math.hypot(a[0] - b[0], a[1] - b[1])); } return g; },
    // the point `d` along a loop (wraps)
    at(L, d) {
      const total = L.reduce((a, s) => a + P.len(s), 0); d = total ? ((d % total) + total) % total : 0;
      for (const s of L) { const l = P.len(s); if (d <= l + 1e-12) { if (s.t === 'L') { const f = l ? d / l : 0; return [s.a[0] + (s.b[0] - s.a[0]) * f, s.a[1] + (s.b[1] - s.a[1]) * f]; } const a = s.a0 + (s.ccw ? 1 : -1) * d / s.r; return [s.c[0] + s.r * Math.cos(a), s.c[1] + s.r * Math.sin(a)]; } d -= l; }
      return P.pt(L[L.length - 1], true);
    },
    circle: (r, cx = 0, cy = 0) => [{ t: 'A', c: [cx, cy], r, a0: Math.PI, a1: Math.PI + TAU, ccw: true }],   // starts at its leftmost point (a bridge goes there)
    poly: pts => pts.map((a, i) => ({ t: 'L', a: a.slice(), b: pts[(i + 1) % pts.length].slice() })),
    map(L, f, rot = 0) { return L.map(s => s.t === 'L' ? { t: 'L', a: f(s.a), b: f(s.b) } : Object.assign({}, s, { c: f(s.c), a0: s.a0 + rot, a1: s.a1 + rot })); },
    move: (L, dx, dy) => P.map(L, q => [q[0] + dx, q[1] + dy]),
    rotate: (L, deg) => { const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); return P.map(L, q => [q[0] * c - q[1] * s, q[0] * s + q[1] * c], a); },
    reverse: L => L.slice().reverse().map(s => s.t === 'L' ? { t: 'L', a: s.b, b: s.a } : Object.assign({}, s, { a0: s.a1, a1: s.a0, ccw: !s.ccw })),
    // points along the loop (for previews, spacing checks and the 3D plate)
    points(L, step = 0.25) { const out = []; for (const s of L) { if (s.t === 'L') out.push(s.a); else { const n = Math.max(2, Math.ceil(P.len(s) / step)), d = (s.ccw ? 1 : -1) * P.sweep(s); for (let k = 0; k < n; k++) { const a = s.a0 + d * k / n; out.push([s.c[0] + s.r * Math.cos(a), s.c[1] + s.r * Math.sin(a)]); } } } return out; },
    area(L) { return K().area(P.points(L, 0.1)); },
    // cut segment s at the point that is `d` along it: [before, after]
    cut(s, d) {
      if (s.t === 'L') { const l = P.len(s), f = d / l, m = [s.a[0] + (s.b[0] - s.a[0]) * f, s.a[1] + (s.b[1] - s.a[1]) * f]; return [{ t: 'L', a: s.a, b: m }, { t: 'L', a: m, b: s.b }]; }
      const am = s.a0 + (s.ccw ? 1 : -1) * d / s.r; return [Object.assign({}, s, { a1: am }), Object.assign({}, s, { a0: am })];
    },
    // the loop as one open chain from distance d0 to d1 along it (d1 may wrap past the end)
    chain(L, d0, d1) {
      const total = L.reduce((a, s) => a + P.len(s), 0), out = []; if (d1 < d0) d1 += total;
      let pos = 0;
      for (let lap = 0; lap < 2; lap++) for (const s of L) {
        const l = P.len(s), s0 = pos, s1 = pos + l; pos = s1;
        if (s1 <= d0 + 1e-9 || s0 >= d1 - 1e-9) continue;
        let seg = s;
        if (d0 > s0 + 1e-9) seg = P.cut(seg, d0 - s0)[1];
        if (d1 < s1 - 1e-9) seg = P.cut(seg, d1 - Math.max(s0, d0))[0];
        out.push(seg);
      }
      return out;
    },
    // offset an open chain to its right (outside of a ccw outline) by k; convex corners get round joins
    offsetRight(C, k) {
      const out = [], nr = (s, end) => { if (s.t === 'L') { const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1], l = Math.hypot(dx, dy) || 1; return [dy / l, -dx / l]; } const a = end ? s.a1 : s.a0, u = [Math.cos(a), Math.sin(a)]; return s.ccw ? u : [-u[0], -u[1]]; };
      C.forEach((s, i) => {
        if (i) { const p = P.pt(s, false), n0 = nr(C[i - 1], true), n1 = nr(s, false); if (Math.hypot(n0[0] - n1[0], n0[1] - n1[1]) > 1e-6) out.push({ t: 'A', c: p, r: k, a0: Math.atan2(n0[1], n0[0]), a1: Math.atan2(n1[1], n1[0]), ccw: (n0[0] * n1[1] - n0[1] * n1[0]) > 0 }); }
        if (s.t === 'L') { const n = nr(s); out.push({ t: 'L', a: [s.a[0] + n[0] * k, s.a[1] + n[1] * k], b: [s.b[0] + n[0] * k, s.b[1] + n[1] * k] }); }
        else out.push(Object.assign({}, s, { r: s.ccw ? s.r + k : s.r - k }));
      });
      return out;
    },
    // exact: segment ends plus the arcs' extreme points (0°, 90°, 180°, 270°) they pass
    bounds(L) {
      const q = [];
      for (const sg of L) { q.push(P.pt(sg, false), P.pt(sg, true)); if (sg.t === 'A') { const sw = P.sweep(sg); for (let k = 0; k < 4; k++) { const a = k * Math.PI / 2; let d = sg.ccw ? a - sg.a0 : sg.a0 - a; d = ((d % TAU) + TAU) % TAU; if (d <= sw + 1e-12) q.push([sg.c[0] + sg.r * Math.cos(a), sg.c[1] + sg.r * Math.sin(a)]); } } }
      return [Math.min(...q.map(p => p[0])), Math.min(...q.map(p => p[1])), Math.max(...q.map(p => p[0])), Math.max(...q.map(p => p[1]))];
    },
  };
  // every contour cleaned (no sub-0.01 mm segments) and closed — a cut line that does not close is refused by the shop
  function closedLoops(loops) {
    return loops.map((L, i) => { const c = P.clean(L), g = P.gapOf(c); if (g > 1e-3) throw new Error(`flat outline ${i + 1} does not close (gap ${g.toFixed(3)} mm)`); return c; });
  }
  // DXF R12, cut lines only: LINE, ARC (always counter-clockwise from start to end), CIRCLE
  function dxfOfProfiles(loops, open = []) {
    loops = closedLoops(loops); open = open.map(P.clean);
    const L = ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1009', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES'];
    const n = v => (+v).toFixed(5), deg = a => { let d = a * 180 / Math.PI % 360; if (d < 0) d += 360; return d.toFixed(6); };
    for (const chain of loops.concat(open)) for (const s of chain) {
      if (s.t === 'L') { L.push('0', 'LINE', '8', 'CUT', '10', n(s.a[0]), '20', n(s.a[1]), '30', '0', '11', n(s.b[0]), '21', n(s.b[1]), '31', '0'); continue; }
      if (P.sweep(s) >= TAU - 1e-9) { L.push('0', 'CIRCLE', '8', 'CUT', '10', n(s.c[0]), '20', n(s.c[1]), '30', '0', '40', n(s.r)); continue; }
      const [a, b] = s.ccw ? [s.a0, s.a1] : [s.a1, s.a0];
      L.push('0', 'ARC', '8', 'CUT', '10', n(s.c[0]), '20', n(s.c[1]), '30', '0', '40', n(s.r), '50', deg(a), '51', deg(b));
    }
    L.push('0', 'ENDSEC', '0', 'EOF'); return L.join('\n') + '\n';
  }
  // STEP AP214 B-rep of a flat part: the loops (outer ccw, holes cw) extruded by t — flat faces, cylindrical faces for the
  // arcs and real circle / line edges, like a CAD program writes it (small file, quoted automatically)
  function stepOfProfiles(name, loops, t) {
    loops = closedLoops(loops);
    const L = [], add = e => { L.push(e); return '#' + L.length; }, num = stepNum, dir = (x, y, z) => add(`DIRECTION('',(${[x, y, z].map(num).join(',')}))`);
    const cp = (x, y, z) => add(`CARTESIAN_POINT('',(${[x, y, z].map(num).join(',')}))`);
    const place = (o, z, x) => add(`AXIS2_PLACEMENT_3D('',${o},${z},${x})`);
    const head = productHead(name, add);
    const Z = dir(0, 0, 1), X = dir(1, 0, 0), vtx = new Map();
    const V = (q, z) => { const k = num(q[0]) + ',' + num(q[1]) + ',' + z; if (!vtx.has(k)) vtx.set(k, add(`VERTEX_POINT('',${cp(q[0], q[1], z)})`)); return vtx.get(k); };
    const faces = [];
    const ringEdges = loops.map(loop => {
      const bot = [], top = [], up = [];
      loop.forEach(s => {
        const a = P.pt(s, false), b = P.pt(s, true);
        for (const [z, list] of [[0, bot], [t, top]]) {
          let geo, sense = '.T.';
          if (s.t === 'L') { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; geo = add(`LINE('',${cp(a[0], a[1], z)},${add(`VECTOR('',${dir(dx / l, dy / l, 0)},${num(l)})`)})`); }
          else { geo = add(`CIRCLE('',${place(cp(s.c[0], s.c[1], z), Z, X)},${num(s.r)})`); if (!s.ccw) sense = '.F.'; }
          list.push(add(`EDGE_CURVE('',${V(a, z)},${V(b, z)},${geo},${sense})`));
        }
        up.push(add(`EDGE_CURVE('',${V(a, 0)},${V(a, t)},${add(`LINE('',${cp(a[0], a[1], 0)},${add(`VECTOR('',${Z},${num(t)})`)})`)},.T.)`));
      });
      return { bot, top, up };
    });
    const loopOf = edges => add(`EDGE_LOOP('',(${edges.map(([e, f]) => add(`ORIENTED_EDGE('',*,*,${e},${f})`)).join(',')}))`);
    // top (normal +z): the loops as they run; bottom (normal -z): the loops backwards
    const topB = ringEdges.map((r, i) => add(`${i ? 'FACE_BOUND' : 'FACE_OUTER_BOUND'}('',${loopOf(r.top.map(e => [e, '.T.']))},.T.)`));
    faces.push(add(`ADVANCED_FACE('',(${topB.join(',')}),${add(`PLANE('',${place(cp(0, 0, t), Z, X)})`)},.T.)`));
    const botB = ringEdges.map((r, i) => add(`${i ? 'FACE_BOUND' : 'FACE_OUTER_BOUND'}('',${loopOf(r.bot.slice().reverse().map(e => [e, '.F.']))},.T.)`));
    faces.push(add(`ADVANCED_FACE('',(${botB.join(',')}),${add(`PLANE('',${place(cp(0, 0, 0), Z, X)})`)},.F.)`));
    // sides: bottom edge forward, up at its end, top edge back, down at its start
    loops.forEach((loop, li) => loop.forEach((s, i) => {
      const r = ringEdges[li], j = (i + 1) % loop.length;
      const lp = loopOf([[r.bot[i], '.T.'], [r.up[j], '.T.'], [r.top[i], '.F.'], [r.up[i], '.F.']]);
      let surf, same = '.T.';
      if (s.t === 'L') { const a = s.a, b = s.b, dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; surf = add(`PLANE('',${place(cp(a[0], a[1], 0), dir(dy / l, -dx / l, 0), dir(dx / l, dy / l, 0))})`); }
      else { surf = add(`CYLINDRICAL_SURFACE('',${place(cp(s.c[0], s.c[1], 0), Z, X)},${num(s.r)})`); if (!s.ccw) same = '.F.'; }
      faces.push(add(`ADVANCED_FACE('',(${add(`FACE_OUTER_BOUND('',${lp},.T.)`)}),${surf},${same})`));
    }));
    const solid = add(`MANIFOLD_SOLID_BREP(${stepStr(name)},${add(`CLOSED_SHELL('',(${faces.join(',')}))`)})`);
    const rep = add(`ADVANCED_BREP_SHAPE_REPRESENTATION(${stepStr(name)},(${solid},${place(cp(0, 0, 0), Z, X)}),${head.ctx})`);
    add(`SHAPE_DEFINITION_REPRESENTATION(${head.pds},${rep})`);
    return stepFile(name, L);
  }
  // a 1:1 printable template (A4 portrait PDF, vector lines): the outline centred, a 50 mm check line, how to print it
  function pdfOfFlat(name, flat, note = '', marks = []) {
    const W = 210, H = 297, pts = flat.loops.map(L => P.points(L, 0.2)), xs = pts.flat().map(q => q[0]), ys = pts.flat().map(q => q[1]);
    // 1:1 when it fits (170 x 220 mm); bigger parts are scaled down and say so (the 50 mm line is then not a check)
    const k = Math.min(1, 170 / Math.max(1e-6, Math.max(...xs) - Math.min(...xs)), 220 / Math.max(1e-6, Math.max(...ys) - Math.min(...ys)));
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2, ox = W / 2 - cx * k, oy = H / 2 + 10 - cy * k;
    const pt = v => (v * 72 / 25.4).toFixed(2), X = v => pt(v * k + ox), Y = v => pt(v * k + oy);
    if (k < 1) note = `SCALED ${Math.round(k * 100)} % (does not fit the page). ` + note;
    const asc = t => String(t).replace(/[^\x20-\x7e]/g, '-').replace(/([()\\])/g, '\\$1');
    const c = ['0 0 0 RG 0.4 w'];
    for (const l of pts) c.push(l.map((q, i) => `${X(q[0])} ${Y(q[1])} ${i ? 'l' : 'm'}`).join(' ') + ' h S');
    for (const l of flat.open || []) { const q = P.points(l, 0.2).concat([P.pt(l[l.length - 1], true)]); c.push(q.map((v, i) => `${X(v[0])} ${Y(v[1])} ${i ? 'l' : 'm'}`).join(' ') + ' S'); }
    if (marks.length) { c.push('0.85 0.1 0.1 RG 0.8 w [2 1.5] 0 d'); for (const [a, b] of marks) c.push(`${X(a[0])} ${Y(a[1])} m ${X(b[0])} ${Y(b[1])} l S`); c.push('[] 0 d 0 0 0 RG'); }
    c.push(`1 w ${pt(20)} ${pt(25)} m ${pt(70)} ${pt(25)} l S ${pt(20)} ${pt(23)} m ${pt(20)} ${pt(27)} l S ${pt(70)} ${pt(23)} m ${pt(70)} ${pt(27)} l S`);
    const txt = (x, y, sz, t) => c.push(`BT /F1 ${sz} Tf ${pt(x)} ${pt(y)} Td (${asc(t)}) Tj ET`);
    txt(20, H - 20, 14, name); txt(20, H - 27, 9, `${(Math.max(...xs) - Math.min(...xs)).toFixed(1)} x ${(Math.max(...ys) - Math.min(...ys)).toFixed(1)} mm, 1:1 template. ${note}`);
    txt(20, 30, 9, '50 mm check line: print at 100 % ("Actual size", no "Fit to page"), then measure this line.'); txt(20, 18, 8, 'CircuitPilot');
    if (marks.length) txt(20, 37, 9, 'Red dashes: snip here (tin snips / side cutters), then file the stubs flush.');
    const stream = c.join('\n'), objs = ['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R]/Count 1>>', `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${pt(W)} ${pt(H)}]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>`, `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`, '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'];
    let out = '%PDF-1.4\n';
    const off = [];
    objs.forEach((o, i) => { off.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const x = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + off.map(v => String(v).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${x}\n%%EOF\n`;
    return out;
  }
  // the slot a laser of width `kerf` leaves along chain C (outside of it): a closed cw loop
  function slotLoop(C, kerf) {
    // a cut made of straight lines (a lanced tab's U): a strip centred on it, corners mitred
    if (C.every(s => s.t === 'L')) {
      const pts = [P.pt(C[0], false), ...C.map(s => s.b)], h = kerf / 2, side = sg => pts.map((q, i) => {
        const nrm = (a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [-dy / l * sg, dx / l * sg]; };
        const n0 = i ? nrm(pts[i - 1], q) : null, n1 = i < pts.length - 1 ? nrm(q, pts[i + 1]) : null;
        if (!n0 || !n1) { const n = n0 || n1; return [q[0] + n[0] * h, q[1] + n[1] * h]; }
        const m = [n0[0] + n1[0], n0[1] + n1[1]], ml = Math.hypot(...m) || 1, c = (n0[0] * m[0] + n0[1] * m[1]) / ml;
        return [q[0] + m[0] / ml * h / Math.max(c, 0.2), q[1] + m[1] / ml * h / Math.max(c, 0.2)];
      });
      let ring = side(1).concat(side(-1).reverse());
      if (K().area(ring) > 0) ring = ring.reverse();   // a hole runs clockwise
      return P.poly(ring);
    }
    const O = P.offsetRight(C, kerf), a0 = P.pt(C[0], false), aN = P.pt(C[C.length - 1], true), o0 = P.pt(O[0], false), oN = P.pt(O[O.length - 1], true);
    return C.concat([{ t: 'L', a: aN, b: oN }], P.reverse(O), [{ t: 'L', a: o0, b: a0 }]);
  }
  // a printed part's mesh as STEP (one triangular face each — what a mesh is; fine for quoting and printing)
  // a mesh with T-junctions (a vertex in the middle of a neighbour's edge — the BSP kernel's box makes them) is not closed
  // for a STEP reader: split every edge at the vertices that lie on it (fan from the triangle's centre: no thin slivers)
  function conform(tris) {
    const key = q => q.map(v => v.toFixed(6)).join(','), uses = new Map();
    for (const t of tris) for (let i = 0; i < 3; i++) { const a = key(t[i]), b = key(t[(i + 1) % 3]), k = a < b ? a + '|' + b : b + '|' + a; uses.set(k, (uses.get(k) || 0) + 1); }
    if (![...uses.values()].some(n => n !== 2)) return tris;
    const verts = new Map(); for (const t of tris) for (const q of t) verts.set(key(q), q);
    const cell = 1, grid = new Map(), ck = (x, y, z) => x + ',' + y + ',' + z;
    for (const q of verts.values()) { const k = ck(Math.floor(q[0] / cell), Math.floor(q[1] / cell), Math.floor(q[2] / cell)); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(q); }
    const onEdge = (p, q) => {
      const lo = [0, 1, 2].map(i => Math.floor((Math.min(p[i], q[i]) - 1e-5) / cell)), hi = [0, 1, 2].map(i => Math.floor((Math.max(p[i], q[i]) + 1e-5) / cell));
      const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], l2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2], res = [];
      if ((hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1) > 20000) return res;
      for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) for (const v of grid.get(ck(x, y, z)) || []) {
        const t = ((v[0] - p[0]) * d[0] + (v[1] - p[1]) * d[1] + (v[2] - p[2]) * d[2]) / l2; if (t <= 1e-6 || t >= 1 - 1e-6) continue;
        if (Math.hypot(p[0] + d[0] * t - v[0], p[1] + d[1] * t - v[1], p[2] + d[2] * t - v[2]) < 1e-5) res.push([t, v]);
      }
      return res.sort((a, b) => a[0] - b[0]).map(r => r[1]);
    };
    const out = [];
    for (const [a, b, c] of tris) {
      const ab = onEdge(a, b), bc = onEdge(b, c), ca = onEdge(c, a);
      if (!ab.length && !bc.length && !ca.length) { out.push([a, b, c]); continue; }
      const P = [a, ...ab, b, ...bc, c, ...ca], m = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
      for (let i = 0; i < P.length; i++) out.push([P[i], P[(i + 1) % P.length], m]);
    }
    return out;
  }
  // STEP of a mesh only when it is a closed solid (every edge on exactly two faces): a STEP that opens as loose faces is worse
  // than none. null otherwise (the BSP-built box can have doubled internal faces)
  function stepOfPolys(name, polys) {
    // a Manifold mesh shares its vertex objects between triangles: keep them apart by identity — two vertices on the same
    // spot (an edge where two features touch) stay two, so every edge has exactly two faces
    {
      const id = new Map(), uses = new Map(), F = [];
      for (const pl of polys) for (let i = 1; i < pl.v.length - 1; i++) F.push([pl.v[0], pl.v[i], pl.v[i + 1]]);
      const nid = v => { if (!id.has(v)) id.set(v, id.size); return id.get(v); };
      for (const t of F) for (let i = 0; i < 3; i++) { const a = nid(t[i]), b = nid(t[(i + 1) % 3]), k = a < b ? a + '|' + b : b + '|' + a; uses.set(k, (uses.get(k) || 0) + 1); }
      if (![...uses.values()].some(n => n !== 2)) return stepOf(name, F.map(t => [t.map(v => [v.x, v.y, v.z, id.get(v)])]));
    }
    const T = conform(K().triangles(polys).map(t => t.map(v => [v.x, v.y, v.z]))), key = q => q.map(v => v.toFixed(6)).join(','), uses = new Map();
    for (const t of T) for (let i = 0; i < 3; i++) { const a = key(t[i]), b = key(t[(i + 1) % 3]), k = a < b ? a + '|' + b : b + '|' + a; uses.set(k, (uses.get(k) || 0) + 1); }
    if ([...uses.values()].some(n => n !== 2)) return null;
    return stepOf(name, T.map(t => [t]));
  }
  // a flat sheet part: STEP from its exact loops (open cut lines become kerf-wide slots)
  const stepOfSheet = (name, flat, t, kerf = 0.2) => stepOfProfiles(name, flat.loops.concat((flat.open || []).map(c => slotLoop(c, kerf))), t);
  // outer loops CCW, holes CW (Manifold's polygons already are; the flat outline of a plate: outer first, CCW)
  const ccwOrHole = l => l;
  // smallest distance between two 2D outlines (0 when they overlap)
  function polyGap(A, B) {
    if (A.some(q => pointIn(q, B)) || B.some(q => pointIn(q, A))) return 0;
    const seg = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy, t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0; return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t); };
    let m = Infinity; for (const [P, Q] of [[A, B], [B, A]]) for (const p of P) for (let i = 0; i < Q.length; i++) m = Math.min(m, seg(p, Q[i], Q[(i + 1) % Q.length]));
    return m;
  }
  function pointIn(q, P) { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, yi] = P[i], [xj, yj] = P[j]; if ((yi > q[1]) !== (yj > q[1]) && q[0] < (xj - xi) * (q[1] - yi) / (yj - yi) + xi) c = !c; } return c; }
  const dxfOf = flat => dxfOfProfiles(flat.loops, flat.open || []);
  const ccwPts = P => K().area(P) < 0 ? P.slice().reverse() : P.slice(), cwPts = P => ccwPts(P).reverse();
  // the flat pattern of a sheet part: the exact outline (and holes / lanced tab lines) it was made from, else its footprint
  function flatOf(p) {
    if (p.flat) return p.flat;
    if (!MK || !p.m) return null;
    const polys = kept(p.m.project()).toPolygons();
    return { loops: polys.map(l => P.poly(l.map(q => [q[0], q[1]]))), open: [] };
  }
  // where along a loop its leftmost (sign -1) or rightmost (+1) point is — the middle of a straight edge when it has one
  function extremeAt(L, sign) {
    let best = null, pos = 0;
    for (const s of L) {
      const l = P.len(s), c = [];
      if (s.t === 'L') { c.push([0, s.a[0]], [l, s.b[0]]); if (Math.abs(s.a[0] - s.b[0]) < 1e-9) c.push([l / 2, s.a[0] + sign * 1e-7]); }
      else { const target = sign < 0 ? Math.PI : 0, sw = P.sweep(s); for (let k = -2; k <= 2; k++) { const a = target + k * TAU, d = (s.ccw ? a - s.a0 : s.a0 - a); if (d >= -1e-9 && d <= sw + 1e-9) c.push([d * s.r, s.c[0] + sign * s.r]); } }
      for (const [d, x] of c) if (!best || sign * x > sign * best.x + 1e-12) best = { d: pos + d, x };
      pos += l;
    }
    return best ? best.d : 0;
  }
  // how much of a loop to cut away around distance d where a bar joins it, so the bar is at least w wide (chord ≥ w)
  function barGap(L, d, w, total) {
    let h = w / 2;
    while (h < total / 4) { const a = P.at(L, d - h), b = P.at(L, d + h); if (Math.hypot(a[0] - b[0], a[1] - b[1]) >= w - 1e-6) return h; h += 0.05; }
    return h;
  }
  const chainW = (L, total, a, b) => { a = ((a % total) + total) % total; b = ((b % total) + total) % total; if (b <= a + 1e-9) b += total; return P.chain(L, a, b); };
  // all plates as ONE part: in a row, each joined to the next by a straight bar ≥ 5 mm wide (JLCCNC refuses webs and
  // bridges under 5 mm, and prices tiny separate plates unevenly). The plates are snipped off at the marked lines.
  // Returns the flat part (exact lines / arcs), its size, the bars and the snip lines.
  function joinedSheet(flats, t, o = {}) {
    const bar = o.bar ?? 5, gap = o.gap ?? 6, n = flats.length, rd = v => Math.round(v * 100) / 100;
    let x = 0;
    const pl = flats.map((f, i) => {
      const b = P.bounds(f.loops[0]), d = [rd(x - b[0]), rd(-(b[1] + b[3]) / 2)]; x = rd(x + (b[2] - b[0]) + gap);
      const mv = L => P.move(L, d[0], d[1]), L = P.clean(mv(f.loops[0])), total = L.reduce((a, q) => a + P.len(q), 0), dl = extremeAt(L, -1), dr = extremeAt(L, 1);
      return { L, total, dl, dr, d, hl: i > 0 ? barGap(L, dl, bar, total) : 0, hr: i < n - 1 ? barGap(L, dr, bar, total) : 0, holes: f.loops.slice(1).map(mv), open: (f.open || []).map(mv) };
    });
    const loop = [], end = () => P.pt(loop[loop.length - 1], true), join = b => { const a = end(); if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-6) loop.push({ t: 'L', a, b: b.slice() }); };
    const push = C => { if (loop.length) join(P.pt(C[0], false)); loop.push(...C); };
    const bars = [], snips = [];
    if (n === 1) loop.push(...pl[0].L);
    else {
      const tops = [];
      pl.forEach((q, i) => {
        if (i < n - 1) { push(chainW(q.L, q.total, q.dl + q.hl, q.dr - q.hr)); tops.push(chainW(q.L, q.total, q.dr + q.hr, q.dl - q.hl)); }
        else push(chainW(q.L, q.total, q.dl + q.hl, q.dl - q.hl));
      });
      for (let i = n - 2; i >= 0; i--) push(tops[i]);
      join(P.pt(loop[0], false));
      for (let i = 0; i < n - 1; i++) {
        const A = pl[i], B = pl[i + 1], aD = P.at(A.L, A.dr - A.hr), aU = P.at(A.L, A.dr + A.hr), bD = P.at(B.L, B.dl + B.hl), bU = P.at(B.L, B.dl - B.hl);
        const ux = (bD[0] + bU[0] - aD[0] - aU[0]) / 2, uy = (bD[1] + bU[1] - aD[1] - aU[1]) / 2, ul = Math.hypot(ux, uy) || 1, u = [ux / ul, uy / ul], m = o.snipAt ?? 0.6;
        bars.push({ width_mm: rd(Math.min(Math.hypot(aU[0] - aD[0], aU[1] - aD[1]), Math.hypot(bU[0] - bD[0], bU[1] - bD[1]))), length_mm: rd(ul) });
        snips.push([[aD[0] + u[0] * m, aD[1] + u[1] * m], [aU[0] + u[0] * m, aU[1] + u[1] * m]], [[bD[0] - u[0] * m, bD[1] - u[1] * m], [bU[0] - u[0] * m, bU[1] - u[1] * m]]);
      }
    }
    const loops = [loop, ...pl.flatMap(q => q.holes)], open = pl.flatMap(q => q.open), bb = P.bounds(loop);
    return { loops, open, size: [rd(bb[2] - bb[0]), rd(bb[3] - bb[1])], bars, snips, offsets: pl.map(q => q.d), chords: pl.map(q => ({ dl: q.dl, dr: q.dr, hl: q.hl, hr: q.hr, L: q.L })) };
  }
  // what a laser-cutting shop checks on a flat part: material webs (between cuts) ≥ web mm, slots / holes ≥ the sheet
  // thickness, no tiny segments, every contour closed. From points every 0.25 mm along every cut.
  function sheetCheck(flat, t = 0.5, o = {}) {
    const web = o.web ?? 5, rd = v => +v.toFixed(2), res = { web_min_mm: null, slot_min_mm: null, tiny_segments: 0, open_contours: 0, issues: [] };
    flat.loops.forEach(L => { res.tiny_segments += L.filter(q => P.len(q) < 0.01).length; if (P.gapOf(L) > 1e-3) res.open_contours++; });
    const S = [], tot = [], nl = flat.loops.length;
    const add = (C, ci) => { let pos = 0; for (const q of C) { const l = P.len(q), k = Math.max(1, Math.ceil(l / 0.25)); for (let j = 0; j < k; j++) S.push({ p: P.at([q], l * j / k), c: ci, d: pos + l * j / k }); pos += l; } tot[ci] = pos; };
    flat.loops.forEach((L, i) => add(L, i)); (flat.open || []).forEach((C, j) => { add(C, nl + j); const e = P.pt(C[C.length - 1], true); S.push({ p: e, c: nl + j, d: tot[nl + j] }); });
    const Lp = flat.loops.map(L => P.points(L, 0.2)), inMat = q => pointIn(q, Lp[0]) && !Lp.slice(1).some(h => pointIn(q, h));
    const R = Math.max(web, t), cell = R, grid = new Map(), key = (i, j) => i + ',' + j;
    S.forEach((s, i) => { const k = key(Math.floor(s.p[0] / cell), Math.floor(s.p[1] / cell)); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
    let wmin = null, smin = null;
    S.forEach((A, i) => {
      const gx = Math.floor(A.p[0] / cell), gy = Math.floor(A.p[1] / cell);
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const j of grid.get(key(gx + a, gy + b)) || []) {
        if (j <= i) continue; const B = S[j], dist = Math.hypot(A.p[0] - B.p[0], A.p[1] - B.p[1]); if (dist >= R || dist < 1e-6) continue;
        if (A.c === B.c) { const dd = Math.abs(A.d - B.d), along = A.c < nl ? Math.min(dd, tot[A.c] - dd) : dd; if (along < dist * 2 + 0.6) continue; }   // neighbours along the same cut
        const m = [(A.p[0] + B.p[0]) / 2, (A.p[1] + B.p[1]) / 2];
        if (inMat(m)) { if (dist < web && (!wmin || dist < wmin.v)) wmin = { v: dist, at: m }; }
        else if (dist < t && (!smin || dist < smin.v)) smin = { v: dist, at: m };
      }
    });
    if ((flat.open || []).length) smin = { v: o.kerf ?? 0.2, at: P.pt(flat.open[0][0], false) };   // an open cut is one laser line: a kerf-wide slot
    if (wmin) { res.web_min_mm = rd(wmin.v); res.issues.push(`material web ${rd(wmin.v)} mm at (${wmin.at.map(rd).join(', ')}) — JLCCNC needs ≥ ${web} mm between cuts (bridges, tabs and strips included)`); }
    if (smin) { res.slot_min_mm = rd(smin.v); res.issues.push(`slot ${rd(smin.v)} mm at (${smin.at.map(rd).join(', ')}) is narrower than the ${t} mm sheet — laser slots / holes must be at least the sheet thickness`); }
    if (res.tiny_segments) res.issues.push(`${res.tiny_segments} outline segment(s) under 0.01 mm`);
    if (res.open_contours) res.issues.push(`${res.open_contours} contour(s) do not close`);
    return res;
  }
  // ---------- assembly guide: one picture per plate (where the wire joins, how it sits), the joined part with its snip
  // lines, and — when a plate changed since the last export — the old outline over the new one and whether it still fits
  function assemblyGuide(plates, joined, previous = {}, title = 'design') {
    const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])), rd = v => (+v).toFixed(1);
    const path = (L, k, ox, oy) => { const q = P.points(L, 0.1); return q.map((v, i) => `${i ? 'L' : 'M'}${(ox + v[0] * k).toFixed(2)},${(oy - v[1] * k).toFixed(2)}`).join('') + 'Z'; };
    const cw = 300, ch = 260, cols = Math.min(3, Math.max(1, plates.length)), out = [];
    let y0 = 70;
    out.push(`<text x="20" y="32" font-size="20" font-weight="600">${esc(title)} — electrode plates: assembly guide</text>`,
      `<text x="20" y="54" font-size="13" fill="#555">Orange dot: the wire joins the BACK of the plate here, over the pod's wire hole. Dashed grey: the plate as last exported (when it changed).</text>`);
    if (joined && joined.loops) {
      const b = P.bounds(joined.loops[0]), w = b[2] - b[0], h = b[3] - b[1], k = Math.min(880 / Math.max(1, w), 160 / Math.max(1, h)), ox = 20 - b[0] * k, oy = y0 + 10 + b[3] * k;
      out.push(`<text x="20" y="${y0}" font-size="15" font-weight="600">1. Snip the plates out of the joined part (${rd(joined.size[0])} × ${rd(joined.size[1])} mm) at the red lines, then file the stubs flush</text>`);
      out.push(`<path d="${joined.loops.map(L => path(L, k, ox, oy)).join('')}" fill="#d9dde3" stroke="#222" stroke-width="1" fill-rule="evenodd"/>`);
      joined.snips.forEach(([a, c], i) => out.push(`<line x1="${(ox + a[0] * k).toFixed(1)}" y1="${(oy - a[1] * k).toFixed(1)}" x2="${(ox + c[0] * k).toFixed(1)}" y2="${(oy - c[1] * k).toFixed(1)}" stroke="#d11" stroke-width="2.5" stroke-dasharray="5 3"/><text x="${(ox + (a[0] + c[0]) / 2 * k).toFixed(1)}" y="${(oy - Math.max(a[1], c[1]) * k - 6).toFixed(1)}" font-size="11" fill="#d11" text-anchor="middle">✂${i + 1}</text>`));
      y0 += h * k + 50;
    }
    out.push(`<text x="20" y="${y0}" font-size="15" font-weight="600">${joined ? '2' : '1'}. Each plate (seen from the back, the side that goes into the pod)</text>`);
    y0 += 14;
    plates.forEach((pl, i) => {
      const cx = 20 + (i % cols) * cw, cy = y0 + Math.floor(i / cols) * ch, L = pl.flat.loops[0], b = P.bounds(L), old = previous[pl.name];
      const ob = old ? P.bounds(old.loops[0]) : b, wB = Math.max(b[2], ob[2]) - Math.min(b[0], ob[0]), hB = Math.max(b[3], ob[3]) - Math.min(b[1], ob[1]);
      const k = Math.min((cw - 40) / Math.max(1, wB), (ch - 90) / Math.max(1, hB)), ox = cx + cw / 2 - 10, oy = cy + 30 + (ch - 90) / 2;
      // back view: x mirrored
      const mir = L2 => P.map(L2, q => [-q[0], q[1]], 0).map(sg => sg.t === 'A' ? Object.assign({}, sg, { a0: Math.PI - sg.a0, a1: Math.PI - sg.a1, ccw: !sg.ccw }) : sg);
      out.push(`<rect x="${cx}" y="${cy}" width="${cw - 20}" height="${ch - 20}" rx="8" fill="#fafbfc" stroke="#ccd"/>`, `<text x="${cx + 10}" y="${cy + 20}" font-size="14" font-weight="600">${esc(pl.name)}</text>`);
      out.push(`<path d="${pl.flat.loops.map(Lq => path(mir(Lq), k, ox, oy)).join('')}" fill="#c9ccd1" stroke="#333" stroke-width="1.2" fill-rule="evenodd"/>`);
      let note = `${rd(b[2] - b[0])} × ${rd(b[3] - b[1])} mm`;
      if (old && JSON.stringify(old.loops) !== JSON.stringify(pl.flat.loops)) {
        out.push(`<path d="${path(mir(old.loops[0]), k, ox, oy)}" fill="none" stroke="#777" stroke-width="1.4" stroke-dasharray="4 3"/>`);
        const dw = (ob[2] - ob[0]) - (b[2] - b[0]), dh = (ob[3] - ob[1]) - (b[3] - b[1]);
        note = `changed: old ${rd(ob[2] - ob[0])} × ${rd(ob[3] - ob[1])} → new ${note}. ` + (dw <= 0.3 && dh <= 0.3 ? 'The old plate still fits the new recess (it is no bigger).' : `The old plate is ${rd(Math.max(dw, 0))} / ${rd(Math.max(dh, 0))} mm too big: file it down to the solid line.`);
      }
      if (pl.hole) { const hx = ox - pl.hole.at[0] * k, hy = oy - pl.hole.at[1] * k; out.push(`<circle cx="${hx.toFixed(1)}" cy="${hy.toFixed(1)}" r="${Math.max(4, pl.hole.d / 2 * k).toFixed(1)}" fill="#f39c12" stroke="#a85d00"/><text x="${(hx + 10).toFixed(1)}" y="${(hy - 8).toFixed(1)}" font-size="11" fill="#a85d00">wire joins here</text>`); }
      out.push(`<foreignObject x="${cx + 8}" y="${cy + ch - 62}" width="${cw - 36}" height="44"><div xmlns="http://www.w3.org/1999/xhtml" style="font:11px sans-serif;color:#333">${esc(note)}${pl.face === 'top' ? ' · top (finger) plate' : ' · skin plate'}</div></foreignObject>`);
    });
    const H = y0 + Math.ceil(plates.length / cols) * ch + 70;
    out.push(`<text x="20" y="${H - 40}" font-size="12" fill="#333">${joined ? '3' : '2'}. Join the wire on the back over the hole (gold PCB: solder; stainless: crimp tab + rivet, spot weld or conductive epoxy), feed it through the hole, press the plate into its recess (a drop of flexible glue).</text>`);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.max(940, cols * cw + 40)}" height="${H}" viewBox="0 0 ${Math.max(940, cols * cw + 40)} ${H}" font-family="sans-serif"><rect width="100%" height="100%" fill="#fff"/>${out.join('')}</svg>`;
  }
  // ---------- gold (ENIG) PCB electrodes: the plates as one 0.6 mm PCB, joined by mouse-bite tabs ----------
  // Top: copper over the whole plate (0.3 mm back from the edge), mask open (gold on the skin), vias tented by mask dots.
  // Bottom: one pad over the pod's wire hole (solder the wire there), the rest bare FR-4 (insulated from the pod).
  // plates: [{name, flat, hole: {at: [dx, dy], d}}]; o: {name, thickness = 0.6, tab = 5, gap = 2, edge = 0.3}
  function electrodePcb(plates, o = {}) {
    if (!plates.length) throw new Error('no electrode plates (electrode({…}) in the 3D script makes them)');
    const name = String(o.name || 'electrodes').replace(/[^\w.-]+/g, '_'), edge = o.edge ?? 0.3, th = o.thickness ?? 0.6, rd = v => +(+v).toFixed(2);
    const J = joinedSheet(plates.map(p => p.flat), th, { bar: o.tab ?? 5, gap: o.gap ?? 2, snipAt: 0 });
    const c6 = v => Math.round(v * 1e6), XY = q => `X${c6(q[0])}Y${c6(q[1])}`;
    const head = (fn, extra = []) => ['G04 CircuitPilot gold electrodes: ' + fn + '*', '%FSLAX46Y46*%', '%MOMM*%', '%LPD*%', 'G01*', ...extra];
    const region = (L, pts) => { L.push('G36*'); pts.forEach((q, i) => L.push(`${XY(q)}D0${i ? 1 : 2}*`)); L.push(`${XY(pts[0])}D01*`, 'G37*'); };
    // inset a closed point ring by k (mitre; the plates are convex or gently curved)
    const inset = (pts, k) => { const n = pts.length, ar = K().area(pts) > 0 ? 1 : -1; return pts.map((q, i) => {
      const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n], n1 = [(q[1] - a[1]), -(q[0] - a[0])], n2 = [(b[1] - q[1]), -(b[0] - q[0])], l1 = Math.hypot(...n1) || 1, l2 = Math.hypot(...n2) || 1;
      const m = [n1[0] / l1 + n2[0] / l2, n1[1] / l1 + n2[1] / l2], ml = Math.hypot(...m) || 1, c = Math.max(0.3, (n1[0] / l1 * m[0] + n1[1] / l1 * m[1]) / ml);
      return [q[0] - ar * m[0] / ml * k / c, q[1] - ar * m[1] / ml * k / c]; }); };
    const ring = L => { const q = P.points(L, 0.1); const out = [q[0]]; for (const v of q.slice(1)) if (Math.hypot(v[0] - out[out.length - 1][0], v[1] - out[out.length - 1][1]) > 0.02) out.push(v); return out; };
    const via = 0.3, viaPad = 0.6, holes = [], bites = [];
    const top = head('top copper (skin side, ENIG)'), bot = head('bottom copper (wire pads)', ['%ADD11C,0.600*%']), tsm = head('top solder mask (open over the plates; vias tented)', ['%ADD12C,0.800*%']), bsm = head('bottom solder mask (wire pads open)'), gko = head('board outline', ['%ADD10C,0.100*%', 'D10*', 'G75*']);
    const pads = [];
    plates.forEach((pl, i) => {
      const d = J.offsets[i], L = P.move(pl.flat.loops[0], d[0], d[1]), cu = inset(ring(L), edge);
      region(top, cu); region(tsm, inset(ring(L), Math.max(0, edge - 0.05)));
      const h = pl.hole || { at: [0, 0], d: 1.6 }, c = [d[0] + h.at[0], d[1] + h.at[1]], pr = Math.max(1.5, (h.d + 1.4) / 2);
      pads.push({ name: pl.name, at: c.map(rd), d_mm: rd(2 * pr) });
      const circ = (L2, r) => region(L2, Array.from({ length: 64 }, (_, k) => [c[0] + r * Math.cos(k * Math.PI / 32), c[1] + r * Math.sin(k * Math.PI / 32)]));
      circ(bot, pr); circ(bsm, pr + 0.05);
      // 4 vias in the pad join it to the skin copper
      for (let k = 0; k < 4; k++) { const a = Math.PI / 4 + k * Math.PI / 2, q = [c[0] + (pr - 0.5) * Math.cos(a), c[1] + (pr - 0.5) * Math.sin(a)]; holes.push(q); bot.push('D11*', `${XY(q)}D03*`); }
    });
    // tented on the skin side: mask dots over the vias (clear polarity = no opening there)
    tsm.push('%LPC*%', 'D12*', ...holes.map(q => `${XY(q)}D03*`), '%LPD*%');
    // outline with true arcs
    for (const L of J.loops) {
      gko.push(`${XY(P.pt(L[0], false))}D02*`);
      for (const sg of L) {
        if (sg.t === 'L') { gko.push('G01*', `${XY(sg.b)}D01*`); continue; }
        const sw = P.sweep(sg), parts = sw > Math.PI ? 2 : 1;
        for (let k = 1; k <= parts; k++) { const a0 = sg.a0 + (sg.ccw ? 1 : -1) * sw * (k - 1) / parts, a1 = sg.a0 + (sg.ccw ? 1 : -1) * sw * k / parts, st = [sg.c[0] + sg.r * Math.cos(a0), sg.c[1] + sg.r * Math.sin(a0)], en = [sg.c[0] + sg.r * Math.cos(a1), sg.c[1] + sg.r * Math.sin(a1)];
          gko.push(sg.ccw ? 'G03*' : 'G02*', `${XY(en)}I${c6(sg.c[0] - st[0])}J${c6(sg.c[1] - st[1])}D01*`); }
      }
    }
    // mouse bites: Ø0.5 holes at 0.8 mm along each tab's joint, on the plate edge (they break clean, little to file)
    for (const [a, b] of J.snips) { const u = [b[0] - a[0], b[1] - a[1]], l = Math.hypot(...u), n = Math.max(2, Math.floor(l / 0.8)); for (let k = 0; k <= n; k++) bites.push([a[0] + u[0] * k / n, a[1] + u[1] * k / n]); }
    for (const L of [top, bot, tsm, bsm, gko]) L.push('M02*');
    const drl = (rows, tool) => ['M48', 'METRIC,TZ', `T1C${tool.toFixed(3)}`, '%', 'T1', ...rows.map(q => `X${q[0].toFixed(3)}Y${q[1].toFixed(3)}`), 'M30'].join('\n') + '\n';
    const files = {
      [`${name}.GTL`]: top.join('\n') + '\n', [`${name}.GBL`]: bot.join('\n') + '\n', [`${name}.GTS`]: tsm.join('\n') + '\n', [`${name}.GBS`]: bsm.join('\n') + '\n',
      [`${name}.GKO`]: gko.join('\n') + '\n', [`${name}-PTH.DRL`]: drl(holes, via), [`${name}-NPTH.DRL`]: drl(bites, 0.5),
    };
    const readme = [`${name} — gold-plated (ENIG) PCB skin electrodes, ${plates.length} plate${plates.length > 1 ? 's' : ''} in one ${J.size.join(' x ')} mm board`, '',
      'Order at JLCPCB (jlcpcb.com) — upload the Gerber zip:',
      `  Layers: 2.  Dimensions: ${J.size.join(' x ')} mm.  PCB qty: as many sets as you want.`,
      `  Delivery format: Single PCB (the plates are already joined by mouse-bite tabs — not "panel by JLCPCB").`,
      `  PCB thickness: ${th} mm.  Surface finish: ENIG, gold thickness 2U" (skin contact; HASL is not for skin).`,
      '  Mark on PCB: Remove Mark (no order number on the skin side).  Silkscreen: none (no file).  Via covering: Tented.',
      '  Solder mask: any colour (it only shows on the back).', '',
      'Each plate: the whole top (skin side) is gold; the back is bare except a round pad over the pod\'s wire hole — solder the wire there, feed it through the hole, press the plate into its recess.',
      ...pads.map(q => `  ${q.name}: wire pad Ø${q.d_mm} mm at (${q.at.join(', ')}) on the board`), '',
      'Snip the tabs at the mouse-bite rows (side cutters) and sand the edge smooth: skin touches it.', ''];
    files['README-gold-electrodes.txt'] = readme.join('\n');
    return { files, size: J.size, pads, plates: plates.length, guide: assemblyGuide(plates, J, {}, name) };
  }
  // ---------- order packs: the files each service takes, with a README of the order settings ----------
  // r: a run() result built with {step: true}; o: {base, service: 'all' | 'jlc3dp' | 'jlccnc', process, script, scad, pcb}
  function exportPack(r, o = {}) {
    const base = String(o.base || 'design').replace(/[^\w.-]+/g, '_'), svc = o.service || 'all', files = {}, P = PROCESSES[o.process] || PROCESSES.mjf;
    const printed = r.parts.filter(p => (p.kind || 'print') === 'print'), metal = r.parts.filter(p => p.kind === 'metal');
    const dir = svc === 'all' ? { print: 'jlc3dp/', metal: 'jlccnc/' } : { print: '', metal: '' };
    const pcbText = o.pcb ? o.pcb.parts.map(q => `${q.value || ''} ${q.module || ''}`).join(' ') : '';
    const radio = /XIAO|ESP32|NRF5|BLE|WIFI|ANTENNA|CC26|DA14|RP2040.?W|PICO.?W/i.test(pcbText), worn = metal.length > 0 || /wrist|chest|ecg|strap|skin|band|patch/i.test(o.script || '');
    const warn = [];
    if (radio) warn.push('No metallic paint, metal plating or carbon-filled material over the antenna end of the radio module — it detunes the antenna and cuts the range.');
    if (worn && (o.process === 'sla')) warn.push('Standard SLA resin is not meant for long skin contact: print parts worn on the skin in MJF PA12 / PA11 instead.');
    if (metal.length) warn.push('Electrode plates: no powder coat, anodizing, paint or lacquer — they insulate the skin contact. Stainless 304 / 316 (or gold-plated brass); not aluminium (its oxide layer insulates and it corrodes in sweat).');
    const d = r.report && r.report.dfm;
    if (d && d.thin.length) warn.push(`The manufacturability check found ${d.thin.length} area(s) thinner than ${P.wall} mm (thinnest ${d.thin[0].min_mm} mm) — the print service may reject or flag the part.`);
    if (svc !== 'jlccnc') {
      for (const p of printed) { files[`${dir.print}${base}-${p.name}.stl`] = p.stl; if (p.step) files[`${dir.print}${base}-${p.name}.step`] = p.step; }
      files[`${dir.print}README-JLC3DP.txt`] = [`${o.base || 'design'} — 3D-printed parts (JLC3DP, jlc3dp.com)`, '',
        'Upload one STL per part (a STEP of the same part is next to it if you prefer STEP). Each file is one part, oriented for printing.', '',
        ...printed.map(p => `  ${p.name}: ${p.size_mm.join(' x ')} mm, ${p.volume_cm3} cm3`), '',
        'Order settings:',
        `  Process: ${P.name}${o.process && o.process !== 'mjf' ? '' : ' — MJF'}`,
        '  Material: PA12-HP Nylon (general), or PA11-HP for parts worn on the skin all day (tougher, a little flexible)',
        '  Colour: Black.  Surface: Dyeing (even black, hides powder marks).  If painted: "Exterior only", so the lid fit stays as designed.',
        `  Walls: minimum ${P.wall} mm for this process; fits are designed with ${P.fit} mm clearance (tolerance about ±${P.fit} mm).`,
        '', 'Resin or nylon?',
        '  Nylon (MJF PA12 / PA11): matte, slightly grainy grey-black; tough and a little flexible (clips and lids do not crack); fine on skin all day (PA11 best). JLC warns on walls under 1.2 mm and refuses under 1.0 mm.',
        '  Resin (SLA): smooth, sharp detail and text; stiffer and more brittle (thin clips snap); standard resins are not made for long skin contact. JLC warns on walls under 0.8 mm.',
        '  JLC resins: LEDO 6060 (tough, the one to wear for testing), Black resin (looks best: display models, photos).',
        '  JLC\'s wall heatmap: red = too thin (fix it); yellow (about 0.5-1.2 mm) is a caution only and fine for small areas such as edges and text.',
        ...(warn.length ? ['', 'Warnings:', ...warn.map(w => '  - ' + w)] : []), ''].join('\n');
    }
    if (svc !== 'jlc3dp' && metal.length) {
      for (const p of metal) { if (p.dxf) files[`${dir.metal}${base}-${p.name}.dxf`] = p.dxf; if (p.step) files[`${dir.metal}${base}-${p.name}.step`] = p.step; }
      const pn = r.report && r.report.joined, t = metal[0].sheet_mm || 0.5;
      if (pn) { files[`${dir.metal}${base}-plates-joined.dxf`] = pn.dxf; files[`${dir.metal}${base}-plates-joined.step`] = pn.step; files[`${dir.metal}${base}-plates-joined-snip-guide.pdf`] = pn.pdf; }
      const tabbed = metal.filter(p => p.flat && (p.flat.open || []).length);
      files[`${dir.metal}README-JLCCNC.txt`] = [`${o.base || 'design'} — flat metal parts (JLCCNC sheet metal, jlccnc.com)`, '',
        pn ? `ORDER THIS: ${base}-plates-joined (STEP + DXF, ${pn.size.join(' x ')} mm) as ONE part, quantity = sets you want. Every plate is joined to the next by a ${pn.bars.length ? Math.min(...pn.bars.map(b => b.width_mm)) : 5} mm bar (JLCCNC refuses bridges / webs under 5 mm, and prices tiny separate plates unevenly — one may come back as "Manual Quote"). Snip the bars at the red dashes of the snip-guide PDF and file the stubs flush.`
          : 'Each part has a STEP and a DXF with the same name (JLCCNC wants both). The DXF has cut lines only.',
        pn ? 'The single plates (one STEP + DXF each) are here too, if you prefer them separately.' : '', '',
        ...metal.map(p => `  ${p.name}: ${p.size_mm.slice(0, 2).join(' x ')} mm, ${t} mm sheet`), '',
        'Order settings:',
        `  Process: Sheet metal — laser cutting only (no bending: the plates are flat, they follow the curve when pressed into their recess)`,
        `  Material: Stainless steel 304 (316 for long skin contact), thickness ${t} mm — the site starts on Aluminium 5052: CHANGE IT to stainless 304`,
        t < 1 ? `  Finish: none (JLCCNC brushes only sheet 1.0 mm and thicker). NO powder coating, anodizing or painting (it insulates the electrodes). No threads, no hardware.`
          : '  Finish: Brushing, or none. NO powder coating, anodizing or painting (it insulates the electrodes). No threads, no hardware.',
        '  Remark for the order: "Laser cut only. Cut every line; there are no bend lines."',
        '', 'Wire: join it on the BACK of each plate, over the wire hole of the pod — stainless does not take normal solder: use a crimped ring / tab under a rivet, spot welding, or conductive epoxy (or order gold-plated PCB electrodes, which solder easily).',
        ...(tabbed.length ? [`  Note: ${tabbed.map(p => p.name).join(', ')} still have a lanced wire tab; its strip and slot are under JLCCNC's 5 mm / thickness rules — remove tab:{} for an automatic quote.`] : []),
        ...(warn.length ? ['', 'Warnings:', ...warn.map(w => '  - ' + w)] : []), ''].join('\n');
      if (o.guide !== false) files[`${dir.metal}${base}-assembly-guide.svg`] = assemblyGuide(metal, pn, o.previous || {}, base);
    }
    const tape = r.parts.filter(p => p.adhesive);
    if (svc === 'all' && tape.length) {
      for (const p of tape) { if (p.dxf) files[`adhesive/${base}-${p.name}.dxf`] = p.dxf; if (p.pdf) files[`adhesive/${base}-${p.name}.pdf`] = p.pdf; }
      files['adhesive/README-adhesive.txt'] = [`${o.base || 'design'} — skin adhesive`, '', 'PDF: a 1:1 template. Print at 100 % ("Actual size"), check the 50 mm line with a ruler, stick the tape (e.g. 3M 2476P double-sided medical tape) on the paper and cut along the line.',
        'DXF: the same outline for a die-cutting / laser-cutting service (cut lines only).', ''].join('\n');
    }
    if (svc === 'all') { if (r.scad) files[`${base}-enclosure.scad`] = r.scad; if (o.script) files[`${base}-enclosure-script.js`] = o.script; if (o.shapes && o.shapes.length) files[`${base}-design-shapes.json`] = JSON.stringify(o.shapes, null, 1); }
    return { files, warnings: warn };
  }
  // the parametric box (Enclosure.build) through the same check: moved into script coordinates (origin = board centre,
  // z = 0 at the board bottom); its own cutouts and vents are the intended openings
  function checkBox(r, ctx, o = {}) {
    // positions stay in the box's own coordinates (as get_enclosure reports them); the board region moves by the origin
    const org = (ctx && ctx.origin) || [0, 0, 0];
    const parts = [{ name: 'base', polys: r.base }, { name: 'lid', polys: r.lid }];
    const sideOf = { left: 'left', right: 'right', front: 'front', back: 'back', lid: 'top', floor: 'bottom' };
    const expected = (r.cuts || []).map(c => ({ side: sideOf[c.side], at: c.side === 'lid' || c.side === 'floor' ? [c.x, c.y, 0] : c.side === 'front' || c.side === 'back' ? [c.centre, 0, c.z] : [0, c.centre, c.z], what: c.label || c.side + ' cutout', r: Math.max(c.w, c.h) / 2 + 4 }));
    if (r.L.P.vents) expected.push({ side: 'top', at: [(r.L.bbox[0] + r.L.bbox[2]) / 2, (r.L.bbox[1] + r.L.bbox[3]) / 2, 0], what: 'vent slots', r: 60 });
    const d = dfmCheck(parts, Object.assign({ pcb: ctx && ctx.pcb, shift: org, expected }, o));
    d.thick = { base: parts[0].thick, lid: parts[1].thick }; d.samples = { base: parts[0].samples, lid: parts[1].samples };
    return d;
  }
  // ---------- running a script ----------
  const HELP = `3D SCRIPT API (JavaScript; units mm; Z up). Build shapes, then register printable parts with part(name, shape, options).
COORDINATES: origin = centre of the PCB outline, X right, Y up (board "top" edge = +Y), Z = 0 at the PCB bottom face; PCB top at z = pcb.thickness.
CONTEXT: pcb = {w, h, thickness, shape:'round'|'ellipse'|'rect'|'rounded'|'polygon', radius (min(w,h)/2), center:[0,0], outline:[[x,y],…], holes:[{x,y,d}], parts:[{ref,type,value,x0,y0,x1,y1,cx,cy,h,side:'top'|'bottom',edge,atEdge,plug,port,module, pads:[{num,net,x,y,w,h,shape,drill}]}]} or null when there is no PCB. pcbPart("E1") (or part("E1") with one argument) → that part; pad("E1.1") → that pad (electrode plates, contacts). Use these instead of numbers so the enclosure follows a board resize or a moved part.
  Component boxes: x0..x1, y0..y1 (modules such as XIAO / Pico: the module body, not the footprint); top parts span z = pcb.thickness … pcb.thickness + h, bottom parts z = -h … 0.
  edge = the side a connector OPENS to (front = -Y, back = +Y), set only for plugs (USB, jacks, a module's USB port) — cut wall holes only for those (connectorCuts does);
  atEdge = side of other parts at the board edge (wire pads, headers: no hole). port = {kind:'USB-C'…, side, x, y, z (centre), w, h, out} for a module's USB receptacle (XIAO, Pico, SuperMini…).
2D: square([w,h],{center}), rect(w,h) (centred), circle(r|{d,fn}), ellipse(rx,ry), roundedRect(w,h,r) (centred), polygon([[x,y],…]), hull2d(...shapes), pcbOutline(offset=0)
    2D booleans (fast kernel): union2d(...s), difference2d(a, ...b), intersection2d(...s) → a region (several outlines, holes) with .offset(r, {join}) .translate .rotate .scale .mirror .extrude .bounds .area
    text2d('ECG', {size, stroke, minRidge}) → text as a region; engrave(shape, region | 'TEXT', {at:[x,y,zFace], depth, face:'top'|'bottom', minRidge (default rules.minRidge: closes ridges thinner than it), name}) → shape with the groove
    2D methods: .translate([x,y]) .rotate(deg) .scale(s|[sx,sy]) .mirror([x,y]) .offset(r) (outward > 0) .bounds .area .extrude(h,{center,scale}) .revolve({angle,fn})
DESIGN SHAPES (set_enclosure {shapes}, or the ✎ Design editor): hand-placed boxes, cylinders, text, connector holes, bosses … applied after the script — solids join a part (target) or become their own part, holes cut every printed part (or one). They are not in this script.
3D: cube([x,y,z],{center}), roundedBox([x,y,z], r, {center:true}) (all edges rounded — great for pods), cylinder({h, r|d, r1, r2, center, fn}),
    sphere(r|{r|d, fn}), torus({R, r}), extrude(shape2d, h, {center, scale}) (linear extrude, scale tapers the top),
    revolve(shape2d, {angle=360, fn}) (profile in X=radius / Y=height plane swept around Z — bands, rings, domes, curved straps),
    hull(...shapes) (convex hull — smooth organic pods from spheres/cylinders), union(...), difference(a, ...b), intersection(...)
    methods: .translate([x,y,z]) .rotate([ax,ay,az]) (degrees, X then Y then Z) or .rotate(deg, [axis]) .scale(s|[x,y,z]) .mirror([x,y,z]) .color('name') .union() .subtract() .intersect() .bounds {min,max,size}
    shaping: .bend(R, {along:'y'|'x', z:0}) wraps the shape around a cylinder of radius R below it (wrist / arm / chest curve, ends drop; z keeps its length)
      .smooth({refine=1, angle=60, smoothness=0}) turns faceted surfaces (low-res hulls, revolves) into one smooth organic surface through the corners;
        edges sharper than angle stay sharp (smoothness 0) — with angle 180 every edge is smoothed and the shape bulges out between its corners (it is not an edge fillet:
        use roundedBox / softSolid / hull of spheres for rounded edges). Subdivides to refine-mm triangles (slower: use ≥ 1). .refine(mm) .warp(p => {p[2] += …}) free deformation
      .trim([nx,ny,nz], offset) keeps the side of a plane .mirrorCopy([1,0,0]) .array(n,[dx,dy,dz]) .grid(nx,ny,dx,dy) .polar(n,{angle=360,start=0}) (copies, unioned)
RULES: rules = {process, minWall, fit, minRidge, minPart} — the project's manufacturing rules (set_enclosure {rules}); use rules.minWall for walls, the kit uses them as defaults.
    feature(kind, shape, {name, depth | width}) names a feature, so a thin spot there is reported as "under engraving X: make it 0.4 deep".
HELPERS: board(extra=0) → PCB slab (outline offset by extra, z 0…thickness); partBoxes({clearance=0.5, side}) → union of component boxes (for cavities);
    resolution(fn) sets segments per circle (default adaptive 12–48; lower = faster); range(a,b,step); log(...); Math.*, PI.
ENCLOSURE KIT (use these — the board then always fits):
    e = envelope({gap=0.5, headroom=0.8, standoff=1.2, side: 'top'|'bottom', parts: [refs], exclude: [refs]}) → space the board needs (side / parts / exclude: only those parts; part heights from set_enclosure partHeights or the estimate — coin-cell holders ≈ 4.4 mm): {w, l, cx, cy (cavity size/centre, covers PCB + every part), zFloor, zTop, top, under, plugs, leds, buttons}
    outlineAround(style, e, margin, cornerR) → 2D outline that contains the cavity + margin; style rect | oval | circle | pill | hex | octagon | squircle
    softSolid(outline2d, z0, z1, roundTop, roundBottom) → solid with rounded top/bottom edges;  cavity(e) → the board pocket
    boardPosts(e) → posts under the PCB (screw pilots at PCB holes);  connectorCuts(e) → openings for edge connectors;  topWindows(e, zTop) → holes above LEDs / buttons
    splitLid(shell, e, e.zTop, {fit, lipW, lipH}) → [base, lid] with a press-fit lip that avoids tall parts
    wristCurve(span, zLow, R) → {sag, cutter}: subtract cutter for a concave underside (cylinder along X; rotate 90° for X straps)
    strapLugs({W, L, z, strap, style: 'slot'|'pins'|'bar', t, cx, cy}) → {add, cut};  snapStuds? use cylinders d 4.2 through the floor for ECG snap electrodes
    beltClip(W, L, zLow, cx, cy);  loop(L, z, cx, cy, R, r) (lanyard / key ring);  ventSlots(e, zTop, n);  mountEars(W, zLow, cx, cy) → {add, cut}
    BATTERY: envelope({battery: 'lipo-502030' | 'lir2032' | '18650' | any 'lipo-TTWWLL' | {t, w, l, mAh}, batteryPlace: 'under' (on the floor below the board) | 'above' (over the parts) | 'beside',
      batterySide: '+x' | '-x' | '+y' | '-y' (beside), batteryRotate: 90, batteryTilt: degrees (tips the cell down away from the board — a tail pocket on a wrist curve)}) makes room
      for a loose cell (e.battery = its box {x0,y0,z0,x1,y1,z1,w,l,t,shape}); batteryCradle(e) → ribs on the floor that hold it; batteryBox(e, clearance) → the cell as a solid;
      battery(id) → its data. Ids and sizes: list_batteries (LIR / CR coins, LiPo pouches TTWWLL, 10440 … 21700). The fit check reports collisions with the battery.
    text('LABEL', {size=5, depth=0.6, stroke, align:'center'|'left'|'right', mirror}) → flat 3D text (A-Z 0-9 - . / + : # …) on XY z 0…depth: subtract to engrave, union to emboss
    honeycomb(w, l, {cell=4, wall=1.2, h=20, at:[x,y,z]}) → hexagon grille cutter;  screwBoss({x, y, z0, h, screw:'M2'|'M2.5'|'M3', insert}) → {add, cut} (heat-set insert or self-tap)
    electrode({name, at:[x,y], shape:'rect'|'circle', w, h, r | d, rotate, z (flat skin side) | curve:{R, axisZ, along:'y'|'x', y0}, plateT=0.5, proud=0.1,
      clearance=0.15, hole=1.6 (wire hole behind it), holeAt:[dx,dy], face:'bottom' (skin, default) | 'top' (finger / lid plate), minGap=5 (0 = no spacing check)}) → {cut}:
      subtract cut from the body; the plate becomes a 'metal' part (DXF + STEP, all plates as one part joined by 5 mm bars + a snip guide, or gold PCB electrodes);
      plates on the same face closer than minGap are reported (sweat bridges them). The wire joins the back of the plate over the hole (no lanced tab: JLCCNC refuses it)
    wireChannel(a, b, d=1.2) → a round channel to cut; radialEnds(shape, {axisZ, angle=30, along:'y', y0}) → end faces square to a wrist curve (no knife-edge tails)
    strapLugs({…, barHole: 1.3 (spring-bar tip hole), contact: true (wire channel from a bar hole into the case: strap as ground)})
    splitLid(shell, e, zSplit, {fit, lipW, lipH, inner, joint: 'rabbet' (stepped joint, flush inside), region: shape2d (lid only inside it)})
    makeLid(shell, e, zSplit, {style: 'lip' | 'rabbet' | 'skirt' (needs outer) | 'inset' (flat plate on a ledge; needs inner; lidT, ledge), fit, pads: [{at:[x,y], w, l | d, h}] (hold the battery / board)}) → [base, lid]
    draftWalls(out, z0, z1, {angle=10 | flare, rTop, rBot}) → sloped "pebble" sides; softSolid(…, {flare}); hollow(out, e, t, roundTop, r, {flare, z0, z1}) follows it
    adhesive({outline, inset=0.8, windows:[electrode results / 2D shapes], windowGrow=1, z, name}) → skin-tape outline: exported as DXF + a 1:1 printable PDF (50 mm check line)
    opening(side, [x,y,z], what, r) declares an opening as intended (wire hole, stud hole, grille) so the openings check does not report it;
    countersink(x, y, zTop, {d=3.2, head}) → cutter;  gap(a, b, max=10) → smallest distance between shapes (mm);  measure(s) → {volume_mm3, area_mm2, min, max, size}
    Pattern: shell = difference(union(softSolid(out, zLow, zTop+t), extras), cavity(e), cuts, connectorCuts(e), topWindows(e, zt)); shell = union(shell, boardPosts(e)); [base, lid] = splitLid(shell, e, e.zTop).
    TEMPLATES: 35 ready scripts (10 wrist, 10 chest / ECG, 7 other body-worn, 8 boxes). FASTEST: set_enclosure_script({template: id, params: {…}}) — no code needed
      (params: shape, wall, r, rTop, rBot, curve, axis, lugs, strap, electrodes, minW, minL, flange, clip, loop, ears, vents, headroom, battery, batteryPlace, label …).
      For more, get the script with enclosure_script_help({template: id}) and edit it.
OUTPUT: part(name, shape, {color, explode:[x,y,z] (offset in the exploded preview), print:{rotate:[ax,ay,az]} (orientation for the STL, dropped onto the bed),
    kind: 'print' (default) | 'metal' (sheet part — electrode plates, shims: no print checks, exported as DXF + STEP, not as a print STL) | 'reference' (shown only), thickness (sheet mm)}).
    Every build also checks manufacturability for the process (set_enclosure process: mjf | sls | sla | fdm): walls thinner than the minimum, knife edges, slits that fuse, lid / base clearance and openings no connector explains.
    Each part is one STL. If no part() is called, the returned shape becomes part "model".
TIPS: hollow shells = difference(outer, inner) where inner is the same shape smaller by the wall; split into a "bottom" and a "top"/"lid" part along a Z plane with intersection(shell, cube) — add a lip so they snap/press-fit (0.15–0.25 mm clearance);
    always size from envelope() (it includes every part, also overhanging ones) — the fit report lists collisions and anything not inside the enclosure; fix both;
    leave 0.3–0.5 mm clearance around the PCB and 0.5 mm above the tallest part; minimum printable wall 1.2 mm (1.6–2 mm recommended); avoid overhangs > 45° or add print rotation.
    Wearables: wrist pods are curved underneath (intersect with a big cylinder of radius 30–40 mm along X), with strap slots/lugs (e.g. 22 mm strap → 23 × 2.5 mm slots); ECG/biopotential patches: snap-electrode studs are 3.9–4 mm, use holes of 4.2 mm on 30–60 mm spacing, keep electrodes on the skin side; leave charging/USB openings.`;

  const EXAMPLES = {
    wristband: `// Whoop-style wrist pod: concave underside that follows the wrist, rounded body, 22 mm strap lugs,
// press-fit lid with a lip, posts under the PCB, opening for the edge connector (USB-C).
resolution(28);
const t = 1.8, gap = 0.5, fit = 0.2;               // wall, PCB clearance, lid fit clearance
const strap = 22, wrist = 34;                      // strap width, wrist radius
const top = pcb ? Math.max(pcb.thickness, ...pcb.parts.filter(p => p.side === 'top').map(p => pcb.thickness + p.h)) : 6;
const under = pcb ? Math.max(0, ...pcb.parts.filter(p => p.side === 'bottom').map(p => p.h)) : 0;
const cw = (pcb ? pcb.w : 32) + 2 * gap, cl = (pcb ? pcb.h : 24) + 2 * gap;   // cavity
const W = cw + 2 * t, L = cl + 2 * t;
const sag = wrist - Math.sqrt(wrist * wrist - (L / 2) * (L / 2));            // depth of the wrist curve
const floorTop = -(under + 1.0);                   // PCB rests on posts 1 mm above the floor
const zb = floorTop - t - sag;                     // lowest point (pod ends)
const zt = top + 0.8 + t;                          // top of the lid
const H = zt - zb;
const body = roundedBox([W, L, H], Math.min(5, H / 2 - 0.1)).translate([0, 0, zb + H / 2]);
const curve = cylinder({ r: wrist, h: W + 20, center: true, fn: 120 }).rotate([0, 90, 0]).translate([0, 0, zb + sag - wrist]);
const lugs = [-1, 1].map(s => difference(
  roundedBox([strap + 6, 7, 5], 2).translate([0, s * (L / 2 + 2.5), zb + sag + 2.5]),
  cube([strap + 1, 2.6, 12], { center: true }).translate([0, s * (L / 2 + 3.2), zb + sag + 2.5])));
const cavity = roundedBox([cw, cl, zt - t - floorTop], 2).translate([0, 0, (floorTop + zt - t) / 2]);
let pod = difference(union(body, ...lugs), curve, cavity);
if (pcb) {                                          // posts under the board corners
  const posts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => cylinder({ d: 3, h: -floorTop + 0.01 }).translate([sx * (pcb.w / 2 - 2), sy * (pcb.h / 2 - 2), floorTop - 0.01]));
  pod = union(pod, ...posts);
  for (const c of pcb.parts.filter(p => p.edge && p.plug)) {   // connector openings through the wall
    const along = c.edge === 'left' || c.edge === 'right';
    const hole = roundedBox([along ? 20 : c.x1 - c.x0 + 1.6, along ? c.y1 - c.y0 + 1.6 : 20, Math.max(3.6, c.h + 1)], 1).translate([along ? (c.edge === 'left' ? -W / 2 : W / 2) : c.cx, along ? c.cy : (c.edge === 'front' ? -L / 2 : L / 2), pcb.thickness + c.h / 2]);
    pod = difference(pod, hole);
  }
}
const split = zt - t;                              // lid = top wall + a lip that drops into the cavity
const lip = difference(
  roundedBox([cw - 2 * fit, cl - 2 * fit, 2], 1.8).translate([0, 0, split - 1]),
  roundedBox([cw - 2 * fit - 2.4, cl - 2 * fit - 2.4, 4], 1.2).translate([0, 0, split - 1]));
part('pod', intersection(pod, cube([300, 300, 200]).translate([-150, -150, split - 200])), { color: 'dimgray' });
part('lid', union(intersection(pod, cube([300, 300, 200]).translate([-150, -150, split])), lip), { color: 'gainsboro', explode: [0, 0, 14], print: { rotate: [180, 0, 0] } });`,
    ecg: `// ECG chest node: low-profile oval pod with 3 snap-electrode holes on the skin side (RA, LA, RL),
// thick bosses around the studs, windows above LEDs and buttons, press-fit cover with a lip.
resolution(36);
const t = 1.6, gap = 0.6, fit = 0.2, stud = 4.2;  // wall, PCB clearance, cover fit, snap-stud hole (Ø3.9-4 mm studs)
const top = pcb ? Math.max(pcb.thickness, ...pcb.parts.filter(p => p.side === 'top').map(p => pcb.thickness + p.h)) : 5;
const under = pcb ? Math.max(0, ...pcb.parts.filter(p => p.side === 'bottom').map(p => p.h)) : 0;
const W = Math.max(70, (pcb ? pcb.w : 0) + 2 * (t + gap) + 24), L = Math.max(40, (pcb ? pcb.h : 0) + 2 * (t + gap) + 6);
const floorTop = -(under + 1.0), zb = floorTop - t - 1.5;   // 1.5 mm extra floor so the snap studs sit firmly
const zt = top + 0.8 + t, H = zt - zb;
const oval = (rx, ry, z0, z1) => hull(extrude(ellipse(rx, ry), 0.01).translate([0, 0, z0]), extrude(ellipse(rx - 2.5, ry - 2.5), 0.01).translate([0, 0, z1 - 0.01]));
const body = oval(W / 2, L / 2, zb, zt);
const cavity = oval(W / 2 - t, L / 2 - t, floorTop, zt - t);
const electrodes = [[-W / 2 + 9, 0], [W / 2 - 9, 0], [0, -L / 2 + 8]];   // RA, LA, RL — 50+ mm apart
const studs = electrodes.map(([x, y]) => cylinder({ d: stud, h: 20, center: true }).translate([x, y, zb]));
const bosses = electrodes.map(([x, y]) => cylinder({ d: 10, h: floorTop - zb + 0.01 }).translate([x, y, zb]));
let shell = difference(union(difference(body, cavity), ...bosses), ...studs);
if (pcb) {
  const posts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => cylinder({ d: 3, h: -floorTop + 0.01 }).translate([sx * (pcb.w / 2 - 2), sy * (pcb.h / 2 - 2), floorTop - 0.01]));
  shell = union(shell, ...posts);
  for (const p of pcb.parts.filter(p => p.side === 'top' && /led|switch/i.test(p.type)))
    shell = difference(shell, cylinder({ d: /led/i.test(p.type) ? 2.5 : 4.5, h: 20 }).translate([p.cx, p.cy, zt - 10]));
}
const split = zt - t;
const lip = difference(oval(W / 2 - t - fit, L / 2 - t - fit, split - 2, split), oval(W / 2 - t - fit - 1.2, L / 2 - t - fit - 1.2, split - 3, split + 1));
part('base', intersection(shell, cube([300, 300, 200]).translate([-150, -150, split - 200])), { color: 'white' });
part('cover', union(intersection(shell, cube([300, 300, 200]).translate([-150, -150, split])), lip), { color: 'lightskyblue', explode: [0, 0, 12], print: { rotate: [180, 0, 0] } });`,
    box: `// Rounded box around the PCB: board on corner posts, connector openings, press-fit lid with a lip.
resolution(24);
const t = 2, gap = 0.5, fit = 0.2;
const top = Math.max(pcb.thickness, ...pcb.parts.filter(p => p.side === 'top').map(p => pcb.thickness + p.h));
const under = Math.max(0, ...pcb.parts.filter(p => p.side === 'bottom').map(p => p.h));
const cw = pcb.w + 2 * gap, cl = pcb.h + 2 * gap, W = cw + 2 * t, L = cl + 2 * t;
const floorTop = -(under + 3), zb = floorTop - t, zt = top + 1.5 + t, H = zt - zb;
let shell = difference(roundedBox([W, L, H], 3).translate([0, 0, zb + H / 2]), roundedBox([cw, cl, zt - t - floorTop], 1).translate([0, 0, (floorTop + zt - t) / 2]));
shell = union(shell, ...[[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => cylinder({ d: 4, h: -floorTop + 0.01 }).translate([sx * (pcb.w / 2 - 2.5), sy * (pcb.h / 2 - 2.5), floorTop - 0.01])));
for (const c of pcb.parts.filter(p => p.edge && p.plug)) {
  const along = c.edge === 'left' || c.edge === 'right';
  shell = difference(shell, cube([along ? 20 : c.x1 - c.x0 + 1.5, along ? c.y1 - c.y0 + 1.5 : 20, Math.max(3.6, c.h + 1)], { center: true }).translate([along ? (c.edge === 'left' ? -W / 2 : W / 2) : c.cx, along ? c.cy : (c.edge === 'front' ? -L / 2 : L / 2), pcb.thickness + c.h / 2]));
}
const split = zt - t;
const lip = difference(roundedBox([cw - 2 * fit, cl - 2 * fit, 2], 0.8).translate([0, 0, split - 1]), cube([cw - 2 * fit - 2.4, cl - 2 * fit - 2.4, 4], { center: true }).translate([0, 0, split - 1]));
part('base', intersection(shell, cube([400, 400, 200]).translate([-200, -200, split - 200])), { color: 'steelblue' });
part('lid', union(intersection(shell, cube([400, 400, 200]).translate([-200, -200, split])), lip), { color: 'yellowgreen', explode: [0, 0, 12], print: { rotate: [180, 0, 0] } });`,
  };

  // ---------- template library (generated from one recipe; each result is a plain, editable script) ----------
  function recipe(o) {
    const L = [];
    L.push(`// ${o.name}`, `// ${o.desc}`, `// Sized from the board: envelope() = PCB + all parts + gap. Change the constants below to adapt it.`);
    L.push(`resolution(${o.res || 32});`);
    L.push(`const shape = '${o.shape}';          // rect | oval | circle | pill | hex | octagon | squircle`);
    L.push(`const t = Math.max(${o.wall ?? 1.8}, rules.minWall || 0);   // wall thickness (mm) — at least the project rule`);
    L.push(`const corner = ${o.r ?? 4};          // corner radius for rect`);
    L.push(`const roundTop = ${o.rTop ?? 2.5}, roundBottom = ${o.rBot ?? 1.2};   // edge rounding`);
    L.push(`const wrist = ${o.curve || 0};             // concave underside radius (0 = flat)`);
    L.push(`const minW = ${o.minW || 0}, minL = ${o.minL || 0};   // minimum outer size (e.g. electrode spacing)`);
    L.push(`const strapAxis = '${o.axis || 'y'}';         // direction the strap / body curve runs (x | y)`);
    if (o.lugs) L.push(`const strap = ${o.strap || 22}, lugStyle = '${o.lugs}';   // strap width, slot | pins | bar`);
    L.push(`const e = envelope({ gap: 0.5, headroom: ${o.headroom ?? 0.8}${o.battery ? `, battery: '${o.battery}', batteryPlace: '${o.batteryPlace || 'under'}'` : ''} });${o.battery ? '   // loose battery (list: battery ids in enclosure_script_help)' : ''}`);
    L.push(`const extra = Math.max(t + ${o.margin ?? 1}, (minW - e.w) / 2, (minL - e.l) / 2);`);
    L.push(`const out = outlineAround(shape, e, extra, corner);`);
    L.push(`const B = out.bounds, BW = B[2] - B[0], BL = B[3] - B[1];`);
    L.push(`let sag = 0, cutter = null, zLow = e.zFloor - t;`);
    L.push(`if (wrist) {   // floor keeps thickness t at the centre, the ends lift by the sag`);
    L.push(`  const span = strapAxis === 'x' ? BW : BL; sag = wristCurve(span, 0, wrist).sag; zLow = e.zFloor - t - sag;`);
    L.push(`  cutter = wristCurve(span, zLow, wrist).cutter; if (strapAxis === 'x') cutter = cutter.rotate([0, 0, 90]); cutter = cutter.translate([e.cx, e.cy, 0]);`);
    L.push(`}`);
    L.push(`const zt = e.zTop + t;`);
    L.push(`const adds = [], cuts = [];`);
    L.push(`let body = softSolid(out, zLow, zt, roundTop, roundBottom);`);
    L.push(`// curved back: end faces square to the wrist (no thin tail where the curve meets the body ends)`);
    L.push(`if (wrist) { const span = strapAxis === 'x' ? BW : BL; body = radialEnds(body, { axisZ: zLow + sag - wrist, angle: Math.asin(Math.min(0.99, (span / 2 - 0.4) / wrist)) * 180 / Math.PI, along: strapAxis, y0: e.cy, x0: e.cx }); }`);
    if (o.flange) L.push(`adds.push(extrude(out.offset(${o.flange}), 1.5).translate([0, 0, zLow - 0.3]));   // adhesive flange (0.3 below the body: no coplanar faces)`);
    if (o.lugs) L.push(`{ const g = strapLugs({ W: strapAxis === 'x' ? BL : BW, L: strapAxis === 'x' ? BW : BL, z: zLow + ${o.lugs === 'pins' ? '3' : '2.4'}, strap, style: lugStyle, t: ${o.lugT || 4.5}, cx: 0, cy: 0, outline: strapAxis === 'x' ? out.translate([-e.cx, -e.cy]).rotate(-90) : out.translate([-e.cx, -e.cy]) });`,
      `  const place = s => strapAxis === 'x' ? s.rotate([0, 0, 90]).translate([e.cx, e.cy, 0]) : s.translate([e.cx, e.cy, 0]); adds.push(place(g.add)); cuts.push(place(g.cut)); }`);
    if (o.electrodes) {
      L.push(`// snap-electrode studs (Ø3.9–4 mm studs → Ø4.2 holes) on the ${o.studsTop ? 'top (lead wires snap on)' : 'skin side'}`);
      const lay = { '3lead': `[[B[0] + 9, e.cy], [B[2] - 9, e.cy], [e.cx, B[1] + 8]]`, '2bar': `[[B[0] + 9, e.cy], [B[2] - 9, e.cy]]`, '5lead': `[[B[0] + 9, B[1] + 9], [B[2] - 9, B[1] + 9], [B[0] + 9, B[3] - 9], [B[2] - 9, B[3] - 9], [e.cx, B[1] + 8]]`, '4square': `[[B[0] + 9, B[1] + 9], [B[2] - 9, B[1] + 9], [B[0] + 9, B[3] - 9], [B[2] - 9, B[3] - 9]]`, 'tri': `[90, 210, 330].map(a => [e.cx + (Math.min(BW, BL) / 2 - 9) * Math.cos(a * PI / 180), e.cy + (Math.min(BW, BL) / 2 - 9) * Math.sin(a * PI / 180)])` }[o.electrodes];
      L.push(`const studs = ${lay};`);
      if (o.studsTop) L.push(`for (const [x, y] of studs) { adds.push(cylinder({ d: 9, h: 1.8 }).translate([x, y, zt - 0.3])); cuts.push(cylinder({ d: 4.2, h: t + 2 }).translate([x, y, zt - t - 0.5])); opening('top', [x, y, zt], 'snap stud hole', 4); }`);
      else L.push(`for (const [x, y] of studs) { adds.push(cylinder({ d: 9, h: 1.8 }).translate([x, y, zLow - 1.5])); cuts.push(cylinder({ d: 4.2, h: e.zFloor - zLow + 2.5 }).translate([x, y, zLow - 2])); opening('bottom', [x, y, zLow], 'snap stud hole', 4); }`);
    }
    if (o.clip) L.push(`adds.push(beltClip(BW, BL, zLow, e.cx, e.cy));   // spring clip on the back`);
    if (o.loop) L.push(`adds.push(loop(BL, (zLow + zt) / 2, e.cx, e.cy, ${o.loopR || 4}, ${o.loopr || 1.6}));   // lanyard / key-ring loop`);
    if (o.ears) L.push(`{ const m = mountEars(BW, zLow, e.cx, e.cy); adds.push(m.add); cuts.push(m.cut); }   // screw ears`);
    if (o.vents) L.push(`cuts.push(ventSlots(e, zt, ${o.vents}));`);
    L.push(`const inner = out.offset(-t);                    // hollow inside, following the outer shape`);
    L.push(`// split where the walls are still straight: under a rounded top the lid is the whole cap (no feather edge on the rim)`);
    L.push(`const zSplit = Math.min(e.zTop, zt - Math.max(roundTop, t) - 0.05);`);
    L.push(`let shell = difference(union(body, ...adds), hollow(out, e, t, roundTop), ...cuts, cutter, connectorCuts(e, 0.6, { zSplit }), topWindows(e, zt));`);
    L.push(`shell = union(shell, boardPosts(e));`);
    if (o.battery) L.push(`shell = union(shell, batteryCradle(e));                // ribs on the floor that hold the cell`);
    if (o.label) L.push(`shell = engrave(shell, text2d('${o.label}', { size: ${o.labelSize || 4} }), { at: [e.cx, e.cy + ${o.labelY || 0}, zt], depth: 0.6, name: '${o.label}' });   // engraved on top`);
    L.push(`const [base, lid] = splitLid(shell, e, zSplit, { fit: rules.fit ?? 0.3, lipH: ${o.lipH ?? 1.6}, inner });`);
    L.push(`part('${o.baseName || 'base'}', base, { color: '${o.c1 || 'dimgray'}' });`);
    L.push(`part('${o.lidName || 'lid'}', lid, { color: '${o.c2 || 'gainsboro'}', explode: [0, 0, 14], print: { rotate: [180, 0, 0] } });`);
    return L.join('\n');
  }
  const TEMPLATES = [
    // wrist
    { id: 'wrist-whoop', cat: 'Wrist', name: 'Whoop-style pod', desc: 'rounded rectangle pod, concave underside, strap loops through end slots', shape: 'rect', r: 5, curve: 34, lugs: 'slot', strap: 22, rTop: 3 },
    { id: 'wrist-round', cat: 'Wrist', name: 'Round watch', desc: 'round case with watch lugs and Ø1.3 spring-bar holes (20 mm strap)', shape: 'circle', lugs: 'pins', strap: 20, rTop: 2.5, rBot: 1.5 },
    { id: 'wrist-square', cat: 'Wrist', name: 'Square smartwatch', desc: 'rounded square case, curved back, 22 mm spring-bar lugs', shape: 'rect', r: 7, curve: 40, lugs: 'pins', strap: 22, rTop: 2 },
    { id: 'wrist-capsule', cat: 'Wrist', name: 'Fitness capsule', desc: 'pill-shaped tracker capsule, curved back, 18 mm strap slots', shape: 'pill', curve: 32, lugs: 'slot', strap: 18, rTop: 3 },
    { id: 'wrist-rugged', cat: 'Wrist', name: 'Rugged outdoor watch', desc: 'octagon case, thick 2.5 mm walls, 24 mm lugs', shape: 'octagon', wall: 2.5, curve: 36, lugs: 'pins', strap: 24, rTop: 1.5, c1: '#3b4a3a', c2: '#7b8b6a' },
    { id: 'wrist-oval', cat: 'Wrist', name: 'Oval tracker', desc: 'oval body, curved back, closed strap bars (20 mm)', shape: 'oval', curve: 33, lugs: 'bar', strap: 20, rTop: 3 },
    { id: 'wrist-hex', cat: 'Wrist', name: 'Hexagon watch', desc: 'hexagonal case, flat back, 20 mm spring-bar lugs', shape: 'hex', lugs: 'pins', strap: 20, rTop: 1.5 },
    { id: 'wrist-squircle', cat: 'Wrist', name: 'Squircle band pod', desc: 'super-ellipse body, curved back, 22 mm strap slots', shape: 'squircle', curve: 35, lugs: 'slot', strap: 22, rTop: 3 },
    { id: 'wrist-slim', cat: 'Wrist', name: 'Slim band', desc: 'thin 1.4 mm walls, low profile, 16 mm strap bars', shape: 'rect', r: 3, wall: 1.4, headroom: 0.5, curve: 30, lugs: 'bar', strap: 16, rTop: 2, lugT: 3.6 },
    { id: 'wrist-cuff', cat: 'Wrist', name: 'Wide cuff', desc: 'long rounded body for a 30 mm cuff strap, curved back', shape: 'rect', r: 4, curve: 30, lugs: 'slot', strap: 30, minL: 30, rTop: 3 },
    // chest
    { id: 'chest-ecg3', cat: 'Chest', name: 'ECG 3-lead oval patch', desc: 'oval pod, 3 snap electrodes (RA, LA, RL) on the skin side, ≥70 mm span', shape: 'oval', electrodes: '3lead', minW: 72, minL: 42, rTop: 3, c1: 'white', c2: 'lightskyblue' },
    { id: 'chest-hr-strap', cat: 'Chest', name: 'Heart-rate strap pod', desc: 'pill pod on a horizontal 30 mm chest strap, 2 electrodes', shape: 'pill', electrodes: '2bar', minW: 62, lugs: 'slot', strap: 30, axis: 'x', rTop: 3 },
    { id: 'chest-holter5', cat: 'Chest', name: 'Holter 5-lead monitor', desc: 'rounded box, 5 snap electrodes, belt clip on the back', shape: 'rect', r: 5, electrodes: '5lead', minW: 80, minL: 56, clip: true, rTop: 2.5 },
    { id: 'chest-disc3', cat: 'Chest', name: 'Round 3-electrode disc', desc: 'round disc patch, 3 electrodes at 120°', shape: 'circle', electrodes: 'tri', minW: 62, minL: 62, rTop: 3 },
    { id: 'chest-adhesive', cat: 'Chest', name: 'Adhesive patch with flange', desc: 'low squircle body with a 6 mm flange for medical adhesive, 2 electrodes', shape: 'squircle', electrodes: '2bar', minW: 64, flange: 6, rTop: 2.5, headroom: 0.6 },
    { id: 'chest-hex3', cat: 'Chest', name: 'Hex 3-electrode patch', desc: 'hexagonal patch, 3 electrodes at 120°', shape: 'hex', electrodes: 'tri', minW: 60, minL: 52, rTop: 2 },
    { id: 'chest-clip', cat: 'Chest', name: 'Harness clip-on pod', desc: 'rounded pod with a spring clip to wear on a harness or bra strap', shape: 'rect', r: 6, clip: true, rTop: 3 },
    { id: 'chest-leadwire', cat: 'Chest', name: 'Lead-wire ECG box', desc: '5 snap studs on top for lead wires, belt clip on the back', shape: 'rect', r: 4, electrodes: '5lead', studsTop: true, minW: 80, minL: 56, clip: true, rTop: 2 },
    { id: 'chest-4square', cat: 'Chest', name: 'Squircle 4-electrode patch', desc: 'four electrodes in a square (impedance / EMG / multi-lead)', shape: 'squircle', electrodes: '4square', minW: 64, minL: 64, rTop: 3 },
    { id: 'chest-slim', cat: 'Chest', name: 'Slim adhesive strip', desc: 'thin pill patch, 2 electrodes, adhesive flange', shape: 'pill', wall: 1.4, headroom: 0.5, electrodes: '2bar', minW: 70, flange: 5, rTop: 2 },
    // other body-worn
    { id: 'body-ankle', cat: 'Body', name: 'Ankle band pod', desc: 'wider curved back (Ø90 mm leg), 30 mm strap slots', shape: 'rect', r: 5, curve: 45, lugs: 'slot', strap: 30, rTop: 3 },
    { id: 'body-armband', cat: 'Body', name: 'Upper-arm band', desc: 'oval pod for an arm strap (38 mm), gentle curve', shape: 'oval', curve: 50, lugs: 'slot', strap: 38, rTop: 3 },
    { id: 'body-headband', cat: 'Body', name: 'Headband / forehead pod', desc: 'low pod, slight curve, strap along the band', shape: 'pill', curve: 80, lugs: 'slot', strap: 25, axis: 'x', rTop: 3 },
    { id: 'body-pendant', cat: 'Body', name: 'Pendant / necklace', desc: 'round body with a lanyard loop', shape: 'circle', loop: true, rTop: 3, rBot: 2 },
    { id: 'body-keyfob', cat: 'Body', name: 'Key fob', desc: 'pill body with a key-ring loop', shape: 'pill', loop: true, loopR: 4.5, rTop: 3, rBot: 2 },
    { id: 'body-beltclip', cat: 'Body', name: 'Belt-clip pod', desc: 'rounded box with a spring belt clip', shape: 'rect', r: 4, clip: true, rTop: 2.5 },
    { id: 'body-badge', cat: 'Body', name: 'Clip-on badge', desc: 'thin rounded card with clip and lanyard loop', shape: 'rect', r: 3, wall: 1.5, clip: true, loop: true, rTop: 1.5 },
    // general boxes
    { id: 'box-rounded', cat: 'Box', name: 'Rounded box', desc: 'rounded box with press-fit lid', shape: 'rect', r: 3, wall: 2, rTop: 2, rBot: 1, c1: 'steelblue', c2: 'yellowgreen' },
    { id: 'box-vented', cat: 'Box', name: 'Vented box', desc: 'rounded box with lid vent slots', shape: 'rect', r: 3, wall: 2, vents: 5, rTop: 2, headroom: 2, c1: 'steelblue', c2: 'silver' },
    { id: 'box-wallmount', cat: 'Box', name: 'Wall-mount box', desc: 'box with two screw ears', shape: 'rect', r: 2, wall: 2, ears: true, rTop: 1.5, c1: '#505860', c2: '#c8ccd0' },
    { id: 'box-puck', cat: 'Box', name: 'Round sensor puck', desc: 'round puck, soft edges', shape: 'circle', wall: 2, rTop: 4, rBot: 2, c1: 'white', c2: '#9ad' },
    { id: 'box-handheld', cat: 'Box', name: 'Handheld remote', desc: 'pill body with a strongly rounded top (comfortable in hand)', shape: 'pill', wall: 2, rTop: 6, rBot: 2, headroom: 1.5 },
    { id: 'box-hex', cat: 'Box', name: 'Hex box', desc: 'hexagonal enclosure', shape: 'hex', wall: 2, rTop: 1.5 },
    { id: 'box-octagon', cat: 'Box', name: 'Octagon box', desc: 'octagonal enclosure', shape: 'octagon', wall: 2, rTop: 1.5 },
    { id: 'box-slim', cat: 'Box', name: 'Slim card', desc: 'thin low-profile case', shape: 'rect', r: 2, wall: 1.4, headroom: 0.5, rTop: 1, rBot: 0.6 },
  ];
  for (const t of TEMPLATES) t.code = recipe(t);
  // a template with some of its settings changed (the AI sends {template, params} instead of a whole script)
  const PARAMS = {
    shape: ['rect', 'oval', 'circle', 'pill', 'hex', 'octagon', 'squircle'], wall: 'mm (1.2-3)', r: 'corner radius mm (rect)', rTop: 'top edge rounding mm', rBot: 'bottom edge rounding mm',
    curve: 'concave underside radius mm (wrist 30-40, ankle 45, arm 50, head 80; 0 = flat)', axis: ['x', 'y'], lugs: ['slot', 'pins', 'bar', 'none'], strap: 'strap width mm', lugT: 'lug thickness mm',
    electrodes: ['none', '3lead', '2bar', '5lead', '4square', 'tri'], studsTop: 'bool: snap studs on top (lead wires)', minW: 'min outer width mm', minL: 'min outer length mm', flange: 'adhesive flange width mm (0 = none)',
    clip: 'bool: belt clip', loop: 'bool: lanyard loop', ears: 'bool: screw ears', vents: 'number of vent slots (0 = none)', headroom: 'mm above the tallest part', margin: 'extra mm around the board', lipH: 'lid lip height mm',
    battery: 'battery id (list_batteries) or none', batteryPlace: ['under', 'above', 'beside'], label: 'text engraved on top (A-Z 0-9 - . /)', labelSize: 'text height mm', res: 'segments per circle (16-64)', c1: 'base colour', c2: 'lid colour',
  };
  function fromTemplate(id, params = {}) {
    const t = TEMPLATES.find(x => x.id === id);
    if (!t) throw new Error(`Unknown template "${id}". Templates: ${TEMPLATES.map(x => x.id).join(', ')}`);
    const o = Object.assign({}, t);
    for (const [k, v] of Object.entries(params || {})) {
      if (!(k in PARAMS)) throw new Error(`Unknown template parameter "${k}". Known: ${Object.keys(PARAMS).join(', ')}`);
      const spec = PARAMS[k];
      if (v === null || v === '' || v === 'none' || v === false) { delete o[k]; continue; }
      if (Array.isArray(spec)) { if (!spec.includes(v)) throw new Error(`${k} must be one of ${spec.join(', ')}`); o[k] = v; }
      else if (/^bool/.test(spec)) o[k] = !!v;
      else if (k === 'battery') o[k] = Enclosure.battery(v).id;
      else if (k === 'label') { const L = String(v).toUpperCase(); if (!/^[A-Z0-9 .\-\/+:#()=*,?_]{1,24}$/.test(L)) throw new Error('label: 1-24 characters A-Z 0-9 and - . / + : # ( )'); o[k] = L; }
      else if (k === 'c1' || k === 'c2') { if (!/^#?[\w]{1,20}$/.test(String(v))) throw new Error(k + ': a colour name or #rrggbb'); o[k] = String(v); }
      else { const n = +v; if (!isFinite(n) || n < 0 || n > 400) throw new Error(`${k} must be a number (mm)`); o[k] = n; }
    }
    o.name = t.name + (Object.keys(params || {}).length ? ' (customised)' : '');
    return recipe(o);
  }

  // legacy names
  Object.assign(EXAMPLES, { wristband: TEMPLATES.find(t => t.id === 'wrist-whoop').code, ecg: TEMPLATES.find(t => t.id === 'chest-ecg3').code, box: TEMPLATES.find(t => t.id === 'box-rounded').code });

  // context: board data in script coordinates (origin = outline centre, y up, z = 0 at the board bottom)
  function context(L) {
    if (!L) return { pcb: null };
    const xs = L.bpoly.map(q => q[0]), ys = L.bpoly.map(q => q[1]);
    const ox = (Math.min(...xs) + Math.max(...xs)) / 2, oy = (Math.min(...ys) + Math.max(...ys)) / 2, r = v => +v.toFixed(3);
    const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
    const parts = L.parts.map(p => {
      const x0 = p.x0 - ox, x1 = p.x1 - ox, y0 = p.y0 - oy, y1 = p.y1 - oy;
      // edge: the side a connector OPENS to (only plugs: USB, jacks, a module's USB port); atEdge: the nearest side of any
      // other part placed at the board edge (wire pads, headers) — those need no hole in the wall
      let edge = null, atEdge = null;
      if (p.edge) { const d = [['left', x0 + w / 2], ['right', w / 2 - x1], ['front', y0 + h / 2], ['back', h / 2 - y1]].sort((a, b) => a[1] - b[1]); if (p.edge.plug) edge = p.port ? p.port.side : d[0][0]; else atEdge = d[0][0]; }
      const port = p.port ? { kind: p.port.kind, side: p.port.side, x: r(p.port.x - ox), y: r(p.port.y - oy), z: r(p.bottom ? -p.port.zc : L.P.pcbThickness + p.port.zc), w: p.port.w, h: p.port.h, out: p.port.out } : null;
      // pads in script coordinates too (electrode plates, test pads, contacts): no more hard-coded positions
      let pads = [];
      try { if (p.c && typeof Pcb !== 'undefined') pads = Pcb.padsOf(p.c, Model.pinIndex()).map(q => ({ num: q.num, net: q.net || null, x: r(q.x - ox), y: r(-q.y - oy), w: r(q.w), h: r(q.h), shape: q.shape || 'rect', drill: q.drill || 0 })); } catch (e) { pads = []; }
      return { ref: p.ref, type: p.type, value: p.value, x0: r(x0), y0: r(y0), x1: r(x1), y1: r(y1), cx: r((x0 + x1) / 2), cy: r((y0 + y1) / 2), h: p.h, side: p.bottom ? 'bottom' : 'top', edge, atEdge, plug: !!(p.edge && p.edge.plug), port, module: p.module || null, pads };
    });
    // board shape in words, and the radius of a round board (so scripts follow a resize)
    const sh = (typeof Model !== 'undefined' && Model.S.board.shape) || { type: 'rect' }, shape = sh.type === 'ellipse' ? (Math.abs(w - h) < 0.01 ? 'round' : 'ellipse') : sh.type === 'polygon' ? 'polygon' : sh.type === 'rounded' ? 'rounded' : 'rect';
    return { pcb: { w: r(w), h: r(h), thickness: L.P.pcbThickness, shape, radius: r(Math.min(w, h) / 2), center: [0, 0], outline: L.bpoly.map(q => [r(q[0] - ox), r(q[1] - oy)]), holes: L.holes.map(q => ({ x: r(q.x - ox), y: r(q.y - oy), d: q.d })), parts }, origin: [ox, oy, L.pcbZ] };
  }

  // ---------- Design: shapes placed by hand (Tinkercad style) on top of the script's parts ----------
  // item: {id, type, name, pos: [x, y, z] (centre of its box), size: [x, y, z], rot: [ax, ay, az] (degrees, X then Y then Z),
  // hole (cuts instead of adding), target ('new' = its own part, 'all' = every printed part, or a part name), color,
  // mirror: [bx, by, bz], scale (groups), r (corner / edge radius), sides, top (cone top / bottom ratio), wall (tube), text, n (slots),
  // cell (honeycomb), array: {n: [nx, ny, nz], step: [dx, dy, dz]}, children (group: solids united, holes cut out), hidden}
  const DENSITY = { mjf: 1.01, sls: 0.95, sla: 1.18, fdm: 1.24 };
  const DESIGN = {
    types: {
      box: { name: 'Box', size: [20, 20, 10] }, roundbox: { name: 'Rounded box', size: [20, 20, 10], r: 2 },
      cylinder: { name: 'Cylinder', size: [12, 12, 10] }, cone: { name: 'Cone', size: [14, 14, 12], top: 0 },
      sphere: { name: 'Sphere', size: [14, 14, 14] }, hemisphere: { name: 'Half sphere', size: [16, 16, 8] },
      torus: { name: 'Torus', size: [20, 20, 4] }, tube: { name: 'Tube', size: [14, 14, 10], wall: 1.6 },
      wedge: { name: 'Wedge', size: [20, 12, 10] }, pyramid: { name: 'Pyramid', size: [16, 16, 12] },
      prism: { name: 'Prism', size: [14, 14, 10], sides: 6 }, stadium: { name: 'Slot (stadium)', size: [10, 6, 4] },
      text: { name: 'Text', size: [30, 8, 1], text: 'TEXT' }, slots: { name: 'Vent slots', size: [24, 14, 10], n: 5, hole: true },
      honeycomb: { name: 'Honeycomb grille', size: [30, 20, 10], cell: 4, hole: true },
    },
    // ready parts: holes sized for real connectors / LEDs, screw bosses, clips — a group can be ungrouped and edited
    presets: {
      usbc: { name: 'USB-C opening', type: 'stadium', size: [9.6, 12, 3.8], hole: true },
      microusb: { name: 'Micro-USB opening', type: 'stadium', size: [8.4, 12, 3.4], hole: true },
      led3: { name: 'LED 3 mm hole', type: 'cylinder', size: [3.2, 3.2, 12], hole: true },
      led5: { name: 'LED 5 mm hole', type: 'cylinder', size: [5.2, 5.2, 12], hole: true },
      lightpipe: { name: 'Light pipe Ø2', type: 'cylinder', size: [2.2, 2.2, 12], hole: true },
      button: { name: 'Button hole Ø6', type: 'cylinder', size: [6.4, 6.4, 12], hole: true },
      jack35: { name: '3.5 mm jack hole', type: 'cylinder', size: [6.4, 12, 6.4], rot: [90, 0, 0], hole: true },
      screw_m2: { name: 'Screw hole M2', type: 'cylinder', size: [2.3, 2.3, 20], hole: true },
      screw_m3: { name: 'Screw hole M3', type: 'cylinder', size: [3.3, 3.3, 20], hole: true },
      boss_m2: { name: 'Boss M2 insert', type: 'group', size: [6.4, 6.4, 6], children: [{ type: 'cylinder', size: [6.4, 6.4, 6], pos: [0, 0, 0] }, { type: 'cylinder', size: [3.2, 3.2, 4.5], pos: [0, 0, 0.8], hole: true }] },
      boss_m3: { name: 'Boss M3 insert', type: 'group', size: [8, 8, 7], children: [{ type: 'cylinder', size: [8, 8, 7], pos: [0, 0, 0] }, { type: 'cylinder', size: [4, 4, 5.5], pos: [0, 0, 0.8], hole: true }] },
      standoff: { name: 'PCB standoff M2', type: 'group', size: [5, 5, 4], children: [{ type: 'cylinder', size: [5, 5, 4], pos: [0, 0, 0] }, { type: 'cylinder', size: [1.7, 1.7, 4.2], pos: [0, 0, 0], hole: true }] },
      rib: { name: 'Stiffening rib', type: 'box', size: [20, 1.2, 6] },
      snap: { name: 'Snap-fit hook', type: 'group', size: [6, 3.2, 8], children: [{ type: 'box', size: [6, 1.4, 8], pos: [0, -0.9, 0] }, { type: 'wedge', size: [6, 1.8, 2.4], pos: [0, 0.7, 2.8], rot: [0, 0, 0] }] },
      strap: { name: 'Strap slot 22 mm', type: 'stadium', size: [23, 3, 20], rot: [90, 0, 0], hole: true },
      magnet: { name: 'Magnet pocket 6×2', type: 'cylinder', size: [6.2, 6.2, 2.2], hole: true },
      label: { name: 'Engraved label', type: 'text', size: [24, 5, 0.6], text: 'NODE-01', hole: true },
    },
  };
  function applyDesign(items, parts, lib, intended, logs) {
    const V = (v, d) => Array.isArray(v) && v.length === 3 ? v.map((x, i) => Number.isFinite(+x) ? +x : d[i]) : d.slice();
    // the primitive of an item, centred on [0, 0, 0] in its size box
    function prim(it) {
      const t = it.type, [x, y, z] = V(it.size, (DESIGN.types[t] || {}).size || [10, 10, 10]).map(v => Math.max(0.05, v)), fn = it.sides ? Math.max(3, Math.round(it.sides)) : undefined;
      switch (t) {
        case 'box': return cube([x, y, z], { center: true });
        case 'roundbox': return roundedBox([x, y, z], Math.max(0, +it.r || 0), { center: true });
        case 'cylinder': case 'prism': return cylinder({ d: x, h: z, center: true, fn: t === 'prism' ? (fn || 6) : fn }).scale([1, y / x, 1]);
        case 'cone': return cylinder({ d1: x, d2: Math.max(0, Math.min(1, +it.top || 0)) * x, h: z, center: true, fn }).scale([1, y / x, 1]);
        case 'sphere': return sphere({ d: x, fn }).scale([1, y / x, z / x]);
        case 'hemisphere': return intersection(sphere({ d: x, fn }), cube([x + 2, x + 2, x / 2 + 1]).translate([-x / 2 - 1, -x / 2 - 1, 0])).scale([1, y / x, 2 * z / x]).translate([0, 0, -z / 2]);
        case 'torus': { const r = Math.min(z, x / 2 - 0.01) / 2; return torus({ R: x / 2 - r, r, fn }).scale([1, y / x, z / (2 * r)]); }
        case 'tube': { const w = Math.max(0.2, Math.min(+it.wall || 1.6, x / 2 - 0.1, y / 2 - 0.1)); return difference(cylinder({ d: x, h: z, center: true, fn }).scale([1, y / x, 1]), cylinder({ d: x - 2 * w, h: z + 1, center: true, fn }).scale([1, (y - 2 * w) / (x - 2 * w), 1])); }
        case 'wedge': return extrude(api2.polygon([[-x / 2, -z / 2], [x / 2, -z / 2], [-x / 2, z / 2]]), y, { center: true }).rotate([90, 0, 0]);
        case 'pyramid': return cylinder({ r1: Math.SQRT1_2, r2: 0, h: z, center: true, fn: 4 }).rotate([0, 0, 45]).scale([x, y, 1]);
        case 'stadium': { const r = Math.min(x, z) / 2 - 1e-3; return extrude(api2.roundedRect(x, z, r), y, { center: true }).rotate([90, 0, 0]); }
        case 'text': {
          const t2 = lib.text(String(it.text || 'TEXT'), { size: y * 0.8, depth: z }), b = t2.bounds;
          const k = Math.min(x / Math.max(0.1, b.size[0]), 1e3); return t2.translate([-(b.min[0] + b.max[0]) / 2, -(b.min[1] + b.max[1]) / 2, -z / 2]).scale([Math.min(1, k), Math.min(1, k), 1]);
        }
        case 'slots': { const n = Math.max(1, Math.round(+it.n || 5)), pitch = x / n, w = Math.max(0.6, pitch * 0.5); return union(Array.from({ length: n }, (_, i) => roundedBox([w, y, z], Math.min(w / 2 - 0.01, 1), { center: true }).translate([-x / 2 + pitch * (i + 0.5), 0, 0]))); }
        case 'honeycomb': return lib.honeycomb(x, y, { cell: +it.cell || 4, h: z, at: [0, 0, 0] });
        case 'group': return build(it.children || []);
        default: throw new Error(`design shape "${it.name || it.id}": unknown type ${t}`);
      }
    }
    // an item in place: mirror, rotate (X, Y, Z), move; copies from its array
    function placed(it) {
      let sh = prim(it); const m = V(it.mirror, [0, 0, 0]);
      for (let k = 0; k < 3; k++) if (m[k]) sh = sh.mirror([k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0]);
      if (it.scale) { const k = V(it.scale, [1, 1, 1]).map(v => Math.max(0.01, Math.abs(v))); if (k.some(v => v !== 1)) sh = sh.scale(k); }
      const r = V(it.rot, [0, 0, 0]); if (r.some(v => v)) sh = sh.rotate(r);
      sh = sh.translate(V(it.pos, [0, 0, 0]));
      const a = it.array; if (a && a.n) { const n = V(a.n, [1, 1, 1]).map(v => Math.max(1, Math.min(50, Math.round(v)))), st = V(a.step, [10, 10, 10]), L = [];
        for (let i = 0; i < n[0]; i++) for (let j = 0; j < n[1]; j++) for (let k = 0; k < n[2]; k++) L.push(sh.translate([st[0] * i, st[1] * j, st[2] * k]));
        if (L.length > 1) sh = union(L); }
      return sh;
    }
    // a list (a group's children): solids united, holes cut out of them
    function build(list) {
      const on = list.filter(c => !c.hidden), sol = on.filter(c => !c.hole).map(placed), hol = on.filter(c => c.hole).map(placed);
      if (!sol.length) { if (!hol.length) throw new Error('an empty group'); return union(hol); }
      return hol.length ? difference(union(sol), ...hol) : union(sol);
    }
    const byName = n => parts.find(p => p.name === n), printed = parts.filter(p => p.kind === 'print'), add = new Map(), cut = new Map(), mine = [];
    for (const it of items) {
      if (!it || it.hidden) continue;
      let sh; try { sh = placed(it); } catch (e) { throw new Error(`design shape "${it.name || it.type}": ${e.message}`); }
      const tg = it.target || (it.hole ? 'all' : 'new');
      if (it.hole) {
        const L = tg === 'all' ? null : byName(tg); if (tg !== 'all' && !L) { logs.push(`design hole "${it.name || it.type}": no part "${tg}" — cuts every part`); }
        cut.set(it, L ? [L] : null);
        const [x, y, z] = V(it.pos, [0, 0, 0]), rr = Math.hypot(...V(it.size, [10, 10, 10])) / 2 + 3;
        for (const side of ['left', 'right', 'front', 'back', 'top', 'bottom']) intended.push({ side, at: [x, y, z], what: `${it.name || it.type} (design hole)`, r: rr });
        Object.defineProperty(it, '_sh', { value: sh, configurable: true });
        continue;
      }
      const L = tg === 'new' ? null : byName(tg);
      if (L) { if (!add.has(L)) add.set(L, []); add.get(L).push(sh); }
      else { if (tg !== 'new') logs.push(`design shape "${it.name || it.type}": no part "${tg}" — made its own part`); const p = { name: String(it.name || it.type).replace(/[^\w.-]+/g, '_'), shape: sh, color: it.color || '#e8a33d', explode: null, print: null, kind: 'print', noPrint: false, sheet: null, design: true };
        let n = p.name, k = 2; while (parts.some(q => q.name === n)) n = p.name + '_' + k++; p.name = n; parts.push(p); mine.push(p); }
    }
    for (const [p, L] of add) p.shape = union(p.shape, ...L);
    for (const [it, L] of cut) for (const p of (L || printed.concat(mine))) p.shape = difference(p.shape, it._sh);
  }
  function run(code, ctx = {}, opts = {}) {
    // fast kernel unless asked for the BSP one (or it is not loaded); a kernel failure retries once with the BSP
    if (MF && opts.kernel !== 'bsp') { try { return run1(code, ctx, Object.assign({}, opts, { kernel: 'manifold' })); } catch (e) { if (!e.kernel) throw e; } }
    return run1(code, ctx, Object.assign({}, opts, { kernel: 'bsp' }));
  }
  function run1(code, ctx = {}, opts = {}) {
    MK = opts.kernel === 'manifold' ? [] : null;
    try { return run2(code, ctx, opts); }
    finally { if (MK) for (const m of MK) { try { m.delete(); } catch (e) { } } MK = null; }
  }
  function run2(code, ctx = {}, opts = {}) {
    const t0 = Date.now(), parts = [], logs = [], extras = [], kitWarn = [], intended = [], features = [];
    // the project's manufacturing rules (set_enclosure {rules}): defaults the kit uses and the checks enforce
    const PR0 = PROCESSES[opts.process] || PROCESSES.mjf, rules = Object.assign({ process: opts.process || 'mjf', minWall: PR0.wall, fit: PR0.fit, minRidge: Math.max(0.6, PR0.wall * 0.6), minPart: PR0.minBox || null }, opts.rules || {});
    budget = t0 + (opts.timeLimitMs || 90000); K().guard.deadline = budget;
    HQ3 = opts.quality === 'high'; K().setQuality(HQ3 ? 'high' : 'preview');
    FN = 0;
    const pcb = ctx.pcb || null;
    const lib = {
      square: api2.square, rect: api2.rect, circle: api2.circle, ellipse: api2.ellipse, roundedRect: api2.roundedRect, polygon: api2.polygon, hull2d: api2.hull2d,
      union2d: (...a) => bool2('union', a), difference2d: (...a) => bool2('difference', a), intersection2d: (...a) => bool2('intersection', a),
      cube, box: cube, roundedBox, cylinder, sphere, torus, extrude, linearExtrude: extrude, revolve, rotateExtrude: revolve, hull, union, difference, intersection,
      pcbOutline: (off = 0) => { if (!pcb) throw new Error('pcbOutline(): this project has no PCB yet'); const s = new Shape2D(pcb.outline); return off ? s.offset(off) : s; },
      board: (extra = 0) => { if (!pcb) throw new Error('board(): this project has no PCB yet'); return extrude(lib.pcbOutline(extra), pcb.thickness); },
      pcbPart: ref => { if (!pcb) throw new Error('pcbPart(): this project has no PCB yet'); const q = pcb.parts.find(x => x.ref === ref); if (!q) throw new Error(`pcbPart(): no part ${ref} on the board`); return q; },
      pad: key => { if (!pcb) throw new Error('pad(): this project has no PCB yet'); const i = String(key).lastIndexOf('.'), q = pcb.parts.find(x => x.ref === String(key).slice(0, i)), d = q && q.pads.find(x => String(x.num) === String(key).slice(i + 1)); if (!d) throw new Error(`pad(): no pad ${key} (use "REF.PIN")`); return d; },
      partBoxes: (o = {}) => {
        if (!pcb) throw new Error('partBoxes(): this project has no PCB yet');
        const c = o.clearance ?? 0.5, ps = pcb.parts.filter(p => !o.side || p.side === o.side);
        return union(ps.map(p => cube([p.x1 - p.x0 + 2 * c, p.y1 - p.y0 + 2 * c, p.h + c]).translate([p.x0 - c, p.y0 - c, p.side === 'top' ? pcb.thickness : -p.h - c])));
      },
      // part("U1") — one string: that PCB part (same as pcbPart); part(name, shape, options): register a printed part
      part: (name, shape, o = {}) => { if (shape === undefined && typeof name === 'string') return lib.pcbPart(name); need3(shape, 'part');
        // print: false / kind 'metal' | 'reference': not 3D-printed (electrode plates, a battery dummy) — no print checks, not in the print STLs
        const kind = o.kind || (o.print === false ? 'reference' : 'print'); if (!['print', 'metal', 'reference'].includes(kind)) throw new Error("part(): kind must be 'print', 'metal' or 'reference'");
        parts.push({ name: String(name || 'part' + (parts.length + 1)).replace(/[^\w.-]+/g, '_'), shape, color: o.color, explode: o.explode ? vec3(o.explode, 'explode') : null, print: o.print && typeof o.print === 'object' ? o.print : null, kind, noPrint: kind !== 'print', sheet: o.thickness ? +o.thickness : null }); return shape; },
      resolution: n => { FN = Math.max(0, Math.min(256, Math.round(+n || 0))); },
      range: (a, b, s = 1) => { const out = []; for (let x = a; s > 0 ? x <= b + 1e-9 : x >= b - 1e-9; x += s) { out.push(+x.toFixed(9)); if (out.length > 10000) break; } return out; },
      log: (...a) => { logs.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')); },
      PI: Math.PI, pcb, rules,
      // name a feature so the manufacturability report can say "thin under engraving X: make it 0.4 deep"
      feature: (kind, shape, o = {}) => { features.push(Object.assign({ kind: String(kind), node: need3(shape, 'feature') }, o)); return shape; },
    };
    // ---------- enclosure kit: building blocks shared by the templates (and available to the AI) ----------
    const K2 = lib;
    // Space the board needs: PCB outline + every part box (connectors that open outward excepted), plus a gap.
    K2.envelope = (o = {}) => {
      const gap = o.gap ?? 0.5, head = o.headroom ?? 0.8, standoff = o.standoff ?? 1.2;
      // no board yet: a w × l (default 32 × 24) cavity 6 mm tall, as if it held a bare board of that size
      const pb = pcb || (() => { const w = (o.w ?? 32) / 2 - gap, l = (o.l ?? 24) / 2 - gap; return { outline: [[-w, -l], [w, -l], [w, l], [-w, l]], parts: [], thickness: 6 }; })();
      const xs = pb.outline.map(q => q[0]), ys = pb.outline.map(q => q[1]);
      let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      // side: 'top' / 'bottom' — only that side's parts; parts / exclude: by reference
      const only = o.parts ? new Set(o.parts) : null, skip = new Set(o.exclude || []);
      const use = pb.parts.filter(p => (!o.side || o.side === 'both' || p.side === o.side) && (!only || only.has(p.ref)) && !skip.has(p.ref));
      for (const p of use) if (!(p.plug && p.edge && !p.port)) { x0 = Math.min(x0, p.x0); x1 = Math.max(x1, p.x1); y0 = Math.min(y0, p.y0); y1 = Math.max(y1, p.y1); }
      x0 -= gap; y0 -= gap; x1 += gap; y1 += gap;
      let top = Math.max(pb.thickness, ...use.filter(p => p.side === 'top').map(p => pb.thickness + p.h));
      let under = Math.max(0, ...use.filter(p => p.side === 'bottom').map(p => p.h)), bat = null;
      if (o.battery) {
        // a loose cell: 'under' the board (on the floor), 'above' the parts (under the lid) or 'beside' the board (on the floor,
        // batterySide '+x' | '-x' | '+y' | '-y', default +x); batteryRotate 90 turns it on the board; batteryTilt (degrees) tips
        // it about the axis along that board edge (a tail pocket that follows the wrist), the far end going down
        const b = Enclosure.battery(o.battery), place = o.batteryPlace || 'under', bottomH = under, side = o.batterySide || '+x';
        if (!['under', 'above', 'beside'].includes(place)) throw new Error("envelope(): batteryPlace must be 'under', 'above' or 'beside'");
        if (!['+x', '-x', '+y', '-y'].includes(side)) throw new Error("envelope(): batterySide must be '+x', '-x', '+y' or '-y'");
        let [bw, bl] = ((x1 - x0) >= (y1 - y0)) === (b.w >= b.l) ? [b.w, b.l] : [b.l, b.w];
        if (place === 'beside' && (side[1] === 'y') === (bw > bl)) [bw, bl] = [bl, bw];   // long side along the board edge
        if (Math.round((o.batteryRotate || 0) / 90) % 2) [bw, bl] = [bl, bw];
        let bx = (x0 + x1) / 2 - bw / 2, by = (y0 + y1) / 2 - bl / 2;
        if (place === 'beside') { if (side === '+x') bx = x1 + 1.5; else if (side === '-x') bx = x0 - 1.5 - bw; else if (side === '+y') by = y1 + 1.5; else by = y0 - 1.5 - bl; }
        let z0, z1;
        if (place === 'under') { under = Math.max(under, bottomH + 0.5 + b.t - standoff); z1 = -(bottomH + 0.3); z0 = z1 - b.t; }
        else if (place === 'above') { z0 = top + 0.3; z1 = z0 + b.t; top = z1; }
        else { z0 = -(under + standoff) + 0.2; z1 = z0 + b.t; top = Math.max(top, z1); }
        const tilt = +o.batteryTilt || 0, rot = !tilt ? null : side[1] === 'y' || place !== 'beside' ? [side === '-y' ? tilt : -tilt, 0, 0] : [0, side === '+x' ? tilt : -tilt, 0];
        bat = { kind: 'battery', id: b.id, name: b.name, shape: b.kind, mAh: b.mAh, place, side: place === 'beside' ? side : null, rot, x0: bx, y0: by, x1: bx + bw, y1: by + bl, z0, z1, cx: bx + bw / 2, cy: by + bl / 2, w: bw, l: bl, t: b.t };
        if (rot) {   // the tipped cell's box: rotate the 8 corners about the end next to the board
          const pv = place === 'beside' ? { '+x': [bat.x0, bat.cy], '-x': [bat.x1, bat.cy], '+y': [bat.cx, bat.y0], '-y': [bat.cx, bat.y1] }[side] : [bat.cx, bat.cy], zc = z1, M = matrixOf({ op: 'rotate', v: rot });
          const cs = []; for (const X of [bat.x0, bat.x1]) for (const Y of [bat.y0, bat.y1]) for (const Z of [z0, z1]) { const q = [X - pv[0], Y - pv[1], Z - zc]; cs.push([0, 1, 2].map(r => M[r][0] * q[0] + M[r][1] * q[1] + M[r][2] * q[2] + [pv[0], pv[1], zc][r])); }
          bat.pivot = [pv[0], pv[1], zc]; bat.box = [0, 1, 2].map(k => Math.min(...cs.map(c => c[k]))).concat([0, 1, 2].map(k => Math.max(...cs.map(c => c[k]))));
          under = Math.max(under, -bat.box[2] - standoff + 0.2);
        }
        const bb = bat.box || [bat.x0, bat.y0, z0, bat.x1, bat.y1, z1];
        x0 = Math.min(x0, bb[0] - gap); x1 = Math.max(x1, bb[3] + gap); y0 = Math.min(y0, bb[1] - gap); y1 = Math.max(y1, bb[4] + gap); top = Math.max(top, bb[5]);
        if (!extras.some(x => x.id === bat.id && Math.abs(x.z0 - bat.z0) < 1e-6 && Math.abs(x.x0 - bat.x0) < 1e-6)) extras.push(bat);
      }
      return { w: x1 - x0, l: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, x0, y0, x1, y1, top, under, zFloor: -(under + standoff), zTop: top + head, gap, battery: bat,
        plugs: pb.parts.filter(p => p.plug && p.edge), leds: pb.parts.filter(p => p.side === 'top' && (/led/i.test(p.type) || /\bled\b/i.test(String(p.value || '')))),
        buttons: pb.parts.filter(p => p.side === 'top' && /switch|button|tact/i.test(p.type)) };
    };
    // 2D outline of a given style that contains the envelope rectangle plus a margin (centred on the envelope)
    K2.outlineAround = (style, e, m = 2, r = 3) => {
      const X = e.w / 2 + m, Y = e.l / 2 + m; let s;
      switch (style) {
        case 'oval': s = api2.ellipse(X * Math.SQRT2, Y * Math.SQRT2, { fn: HQ3 ? 192 : 96 }); break;
        case 'circle': { const R = Math.hypot(X, Y); s = api2.circle(R, { fn: HQ3 ? 192 : 96 }); break; }
        case 'pill': { const long = X >= Y, A = long ? X : Y, B = long ? Y : X, R = B * 1.18, c = Math.max(0, A - Math.sqrt(R * R - B * B)); s = api2.roundedRect(long ? 2 * (c + R) : 2 * R, long ? 2 * R : 2 * (c + R), R * 0.9, { fn: HQ3 ? 128 : 64 }); break; }   // r < R: no µm-short straight edge at the ends
        case 'hex': { const Rc = Math.max(X + Y / Math.sqrt(3), 2 * Y / Math.sqrt(3)) + 0.01; s = api2.polygon([0, 60, 120, 180, 240, 300].map(a => [Rc * Math.cos(a * Math.PI / 180), Rc * Math.sin(a * Math.PI / 180)])); break; }
        case 'octagon': { const k = Math.min(X, Y) * 0.32, ax = X + k, ay = Y + k, c = 2 * k + 0.01; s = api2.polygon([[ax, ay - c], [ax - c, ay], [-ax + c, ay], [-ax, ay - c], [-ax, -ay + c], [-ax + c, -ay], [ax - c, -ay], [ax, -ay + c]]); break; }
        case 'squircle': { const a = X * Math.pow(2, 0.25), b = Y * Math.pow(2, 0.25), n = HQ3 ? 192 : 96, pts = []; for (let k = 0; k < n; k++) { const t = k / n * 2 * Math.PI, c = Math.cos(t), si = Math.sin(t); pts.push([a * Math.sign(c) * Math.sqrt(Math.abs(c)), b * Math.sign(si) * Math.sqrt(Math.abs(si))]); } s = api2.polygon(pts); break; }
        default: s = api2.roundedRect(2 * X, 2 * Y, Math.min(r, X - 0.01, Y - 0.01), { fn: HQ3 ? 128 : 48 });
      }
      return s.translate([e.cx, e.cy]);
    };
    // solid with rounded top and bottom edges from a convex outline (hull of offset rings)
    // o.flare (mm): the top outline is that much smaller than the bottom one — sloped "pebble" sides (negative: wider top)
    K2.softSolid = (out, z0, z1, rTop = 2, rBot = 1, o = {}) => {
      const H = z1 - z0, fl = +o.flare || 0; rTop = Math.max(0, Math.min(rTop, H / 2 - 0.02)); rBot = Math.max(0, Math.min(rBot, H / 2 - 0.02));
      if (rTop < 0.05 && rBot < 0.05 && !fl) return extrude(out, H).translate([0, 0, z0]);
      const ring = (inset, z) => { const d = inset + fl * (z - z0) / H; return { z, pts: (Math.abs(d) > 0.01 ? out.offset(-d) : out).pts }; };
      const rings = [], steps = 3;
      for (let k = 0; k <= steps; k++) { const a = (Math.PI / 2) * k / steps; if (rBot >= 0.05) rings.push(ring(rBot * (1 - Math.sin(a)), z0 + rBot * (1 - Math.cos(a)))); }
      if (rBot < 0.05) rings.push(ring(0, z0));
      for (let k = 0; k <= steps; k++) { const a = (Math.PI / 2) * k / steps; if (rTop >= 0.05) rings.push(ring(rTop * (1 - Math.cos(a)), z1 - rTop * (1 - Math.sin(a)))); }
      if (rTop < 0.05) rings.push(ring(0, z1));
      return new Shape({ op: 'rings', rings });
    };
    // the cavity the board lives in
    // (its ceiling sits 0.25 mm above zTop, so it is never coplanar with the base / lid split at zTop)
    // hollow interior that follows the outer outline at wall thickness t (always includes the board pocket)
    // (with roundTop the inner top follows the rounded outer top, so the lid keeps its wall thickness at the edges)
    // draftWalls(out, z0, z1, {angle (deg from vertical) | flare (mm), rTop, rBot}) — sloped sides
    K2.draftWalls = (out, z0, z1, o = {}) => K2.softSolid(out, z0, z1, o.rTop ?? 1.5, o.rBot ?? 0.8, { flare: o.flare ?? (z1 - z0) * Math.tan(num(o.angle ?? 10, 'angle') * Math.PI / 180) });
    // o.flare / o.z0 / o.z1: the outer body is drafted — the inside follows it at the wall thickness
    K2.hollow = (out, e, t, roundTop = 0, r = 1, o = {}) => o.flare ? union(K2.cavity(e, r), (() => { const z0 = o.z0 ?? e.zFloor, z1 = o.z1 ?? e.zTop, H = z1 - z0, fl = +o.flare, a = e.zFloor, b = e.zTop + 0.25; const at = z => fl * (z - z0) / H; return new Shape({ op: 'rings', rings: [{ z: a, pts: out.offset(-t - at(a)).pts }, { z: b, pts: out.offset(-t - at(b)).pts }] }); })()) : union(K2.cavity(e, r), roundTop > t + 0.05 ? K2.softSolid(out.offset(-t), e.zFloor, e.zTop + 0.25, roundTop - t, 0) : extrude(out.offset(-t), e.zTop + 0.25 - e.zFloor).translate([0, 0, e.zFloor]));
    K2.cavity = (e, r = 1) => extrude(api2.roundedRect(e.w, e.l, Math.min(r, e.w / 2 - 0.01, e.l / 2 - 0.01)).translate([e.cx, e.cy]), e.zTop + 0.25 - e.zFloor).translate([0, 0, e.zFloor]);
    // posts under the board corners (clear of bottom-side parts); pilot holes at PCB mounting holes
    K2.boardPosts = (e, d = 3) => {
      if (!pcb) return null;
      const xs = pcb.outline.map(q => q[0]), ys = pcb.outline.map(q => q[1]), i = d / 2 + 0.8, list = [];
      const spots = pcb.holes.length ? pcb.holes.map(h => [h.x, h.y]) : [[Math.min(...xs) + i, Math.min(...ys) + i], [Math.max(...xs) - i, Math.min(...ys) + i], [Math.max(...xs) - i, Math.max(...ys) - i], [Math.min(...xs) + i, Math.max(...ys) - i]];
      const inPoly = (x, y) => { let c = false; const P = pcb.outline; for (let a = 0, b = P.length - 1; a < P.length; b = a++) { const [xa, ya] = P[a], [xb, yb] = P[b]; if ((ya > y) !== (yb > y) && x < (xb - xa) * (y - ya) / (yb - ya) + xa) c = !c; } return c; };
      for (const [x, y] of spots) {
        if (!inPoly(x, y)) continue;
        if (pcb.parts.some(p => p.side === 'bottom' && x > p.x0 - d / 2 - 0.3 && x < p.x1 + d / 2 + 0.3 && y > p.y0 - d / 2 - 0.3 && y < p.y1 + d / 2 + 0.3)) continue;
        const B = e.battery; if (B && B.z1 < 0.1 && x > B.x0 - d / 2 - 0.3 && x < B.x1 + d / 2 + 0.3 && y > B.y0 - d / 2 - 0.3 && y < B.y1 + d / 2 + 0.3) continue;   // the cell is there
        let post = cylinder({ d: pcb.holes.length ? Math.max(d, 4.5) : d, h: -e.zFloor + 0.01 }).translate([x, y, e.zFloor - 0.01]);
        if (pcb.holes.length) post = difference(post, cylinder({ d: 2.5, h: 20, center: true }).translate([x, y, e.zFloor]));
        list.push(post);
      }
      return list.length ? union(list) : null;
    };
    // openings for edge connectors (USB, jacks…) through the walls
    // o.zSplit: an opening that would end just under the base / lid split (a sliver of wall above it) runs up through the split
    K2.connectorCuts = (e, m = 0.6, o = {}) => {
      const cuts = [], lift = (zc, hz) => { const top = zc + hz / 2; if (o.zSplit == null || top > o.zSplit || o.zSplit - top >= 1.2) return [zc, hz]; const bot = zc - hz / 2, t2 = o.zSplit + 0.6; return [(bot + t2) / 2, t2 - bot]; };
      for (const p of e.plugs) {
        if (p.port) {   // a module's USB port: opening of the receptacle's size and height, from 1 mm inside the module edge outwards
          const q = p.port, D = 120, [qz, hz] = lift(q.z, q.h + 2 * m), wz = q.w + 2 * m, r = Math.min(1.2, (q.h + 2 * m) / 2 - 0.05), along = q.side === 'left' || q.side === 'right';
          const sg = q.side === 'left' || q.side === 'front' ? -1 : 1;
          cuts.push(roundedBox(along ? [D, wz, hz] : [wz, D, hz], r).translate(along ? [q.x + sg * (D / 2 - 1), q.y, qz] : [q.x, q.y + sg * (D / 2 - 1), qz]));
          continue;
        }
        const [zc, hz] = lift(p.side === 'top' ? pcb.thickness + p.h / 2 : -p.h / 2, p.h + 2 * m);
        const sx = p.x1 - p.x0 + 2 * m, sy = p.y1 - p.y0 + 2 * m, D = 120, r = Math.min(0.8, Math.min(sx, sy, hz) / 2 - 0.05);
        if (p.edge === 'left') cuts.push(roundedBox([D, sy, hz], r).translate([(p.x0 + p.x1) / 2 - D / 2, p.cy, zc]));
        else if (p.edge === 'right') cuts.push(roundedBox([D, sy, hz], r).translate([(p.x0 + p.x1) / 2 + D / 2, p.cy, zc]));
        else if (p.edge === 'front') cuts.push(roundedBox([sx, D, hz], r).translate([p.cx, (p.y0 + p.y1) / 2 - D / 2, zc]));
        else cuts.push(roundedBox([sx, D, hz], r).translate([p.cx, (p.y0 + p.y1) / 2 + D / 2, zc]));
      }
      return cuts.length ? union(cuts) : null;
    };
    // light / button windows above LEDs and switches
    K2.topWindows = (e, zt, o = {}) => {
      const list = [];
      for (const p of e.leds.concat(e.buttons)) intended.push({ side: 'top', at: [p.cx, p.cy, zt], what: `${p.ref} window`, r: 5 });
      for (const p of e.leds) list.push(cylinder({ d: o.led ?? 2.6, h: zt - p.h + 20 }).translate([p.cx, p.cy, pcb.thickness + p.h - 0.2]));
      for (const p of e.buttons) list.push(cylinder({ d: o.button ?? Math.min(6, Math.max(3, Math.min(p.x1 - p.x0, p.y1 - p.y0) * 0.7)), h: zt + 20 }).translate([p.cx, p.cy, pcb.thickness + p.h - 0.2]));
      return list.length ? union(list) : null;
    };
    // split into base and lid at zSplit; the lid gets a press-fit lip that steers around tall parts
    K2.splitLid = (shell, e, zSplit, o = {}) => {
      const fit = o.fit ?? rules.fit ?? 0.3, lw = o.lipW ?? 1.2, lh = o.lipH ?? 1.6, b = shell.bounds, m = 1.37;   // cutting boxes just larger than the part (precision)
      const sx = b.size[0] + 2 * m, sy = b.size[1] + 2 * m;
      let below = intersection(shell, cube([sx, sy, zSplit - b.min[2] + m]).translate([b.min[0] - m, b.min[1] - m, b.min[2] - m]));
      let above = intersection(shell, cube([sx, sy, b.max[2] - zSplit + m]).translate([b.min[0] - m, b.min[1] - m, zSplit]));
      let base0 = below;
      // region: the lid only inside this 2D outline (where the shell is still thick enough); the rest stays on the base
      if (o.region) { const R = extrude(need2(o.region, 'splitLid region'), 1000).translate([0, 0, -500]); base0 = union(below, difference(above, R)); above = intersection(above, R); }
      if (lh > 0 && !(e.w > 2 * (lw + fit) + 2 && e.l > 2 * (lw + fit) + 2)) kitWarn.push(`splitLid: lid lip skipped — the cavity (${e.w.toFixed(1)} × ${e.l.toFixed(1)} mm) has no room for a ${lw} mm lip with ${fit} mm fit; the lid is flat with nothing to locate it (use a smaller lipW, or joint: 'rabbet')`);
      if (o.joint === 'rabbet') {
        // stepped joint: the base wall gives up its inner part over lipH, the lid's lip fills it — flush inside, nothing in the cavity
        if (!o.inner) throw new Error("splitLid joint: 'rabbet' needs inner (the hollow's outline)");
        const notch = difference(extrude(o.inner.offset(lw + fit), lh + 0.01).translate([0, 0, zSplit - lh]), extrude(o.inner.offset(-0.3), lh + 2).translate([0, 0, zSplit - lh - 1]));
        const rim = difference(extrude(o.inner.offset(lw), lh + 0.4).translate([0, 0, zSplit - lh]), extrude(o.inner, lh + 2).translate([0, 0, zSplit - lh - 1]));
        return [difference(base0, notch), union(above, rim)];
      }
      below = base0;
      if (lh > 0 && e.w > 2 * (lw + fit) + 2 && e.l > 2 * (lw + fit) + 2) {
        // lip along the inside wall: o.inner (the hollow outline) when given, else the board pocket; corners rounder than
        // the pocket's so the two never run nearly tangent (clean booleans)
        const o1 = o.inner ? o.inner.offset(-fit) : api2.roundedRect(e.w - 2 * fit, e.l - 2 * fit, 2.2).translate([e.cx, e.cy]);
        const o2 = o.inner ? o.inner.offset(-fit - lw) : api2.roundedRect(e.w - 2 * fit - 2 * lw, e.l - 2 * fit - 2 * lw, 1.0).translate([e.cx, e.cy]);
        let lip = difference(extrude(o1, lh + 0.4).translate([0, 0, zSplit - lh]), extrude(o2, lh + 2).translate([0, 0, zSplit - lh - 1]));
        // above the split the lip reaches out to the lid wall: otherwise a fit-wide slit runs round inside the lid (it fuses)
        const o0 = o.inner ? o.inner.offset(0.3) : api2.roundedRect(e.w + 0.6, e.l + 0.6, 2.5).translate([e.cx, e.cy]);
        // … and up into the cavity ceiling (e.zTop + 0.25): a lip that stops just under it leaves a thin air layer above it
        const capH = Math.max(0.4, e.zTop + 0.4 - zSplit);
        lip = union(lip, difference(extrude(o0, capH).translate([0, 0, zSplit]), extrude(o2, capH + 2).translate([0, 0, zSplit - 1])));
        if (pcb) {
          const B = e.battery, bz = B ? (B.box ? B.box[5] : B.z1) : -INF;
          const tall = pcb.parts.filter(p => p.side === 'top' && pcb.thickness + p.h > zSplit - lh - 0.3).concat(B && bz > zSplit - lh - 0.3 ? [{ ref: 'battery', x0: B.box ? B.box[0] : B.x0, y0: B.box ? B.box[1] : B.y0, x1: B.box ? B.box[3] : B.x1, y1: B.box ? B.box[4] : B.y1, h: bz - pcb.thickness }] : []);
          if (tall.length) {
            const v0 = MK ? evalM(lip.node).volume() : null;
            // a part near the wall: the notch runs out through the wall side of the lip (else a thin strip of lip stays
            // between the notch and the wall — an "edge lip" the print service flags)
            const near = lw + fit + 1.5, ex = e.cx - e.w / 2, ey = e.cy - e.l / 2, fx = e.cx + e.w / 2, fy = e.cy + e.l / 2;
            lip = difference(lip, ...tall.map(p => { const x0 = p.x0 - 0.4 - (p.x0 - ex < near ? 20 : 0), y0 = p.y0 - 0.4 - (p.y0 - ey < near ? 20 : 0), x1 = p.x1 + 0.4 + (fx - p.x1 < near ? 20 : 0), y1 = p.y1 + 0.4 + (fy - p.y1 < near ? 20 : 0);
              return cube([x1 - x0, y1 - y0, 40]).translate([x0, y0, -10]); }));
            const v1 = MK ? evalM(lip.node).volume() : null;
            if (v0 && v1 < v0 * 0.4) kitWarn.push(`splitLid: tall parts ${tall.map(p => p.ref).join(', ')} reach above the split, so ${Math.round((1 - v1 / v0) * 100)}% of the lid lip was cut away${v1 < 1 ? ' (no lip left)' : ''} — the lid has little to locate it. Raise the split (zSplit above ${(pcb.thickness + Math.max(...tall.map(p => p.h))).toFixed(1)}), use a lower lipH, or joint: 'rabbet'`);
          }
        }
        above = union(above, lip);
      }
      return [below, above];
    };
    // makeLid(shell, e, zSplit, {style, fit, lipW, lipH, inner, outer, step, lidT, ledge, pads}) → [base, lid]  (not "lid": scripts name their part lid)
    //   style 'lip' (default: press-fit lip inside the wall) | 'rabbet' (stepped joint, flush inside) | 'skirt' (the lid's skirt
    //   wraps the outside of the base over lipH; needs outer) | 'inset' (a flat lid plate inside the walls, resting on a ledge;
    //   needs inner; lidT, ledge). pads: [{at: [x, y], w, l | d, h}] — blocks under the lid that hold the battery / board down.
    K2.makeLid = (shell, e, zSplit, o = {}) => {
      const style = o.style || 'lip', fit = o.fit ?? rules.fit ?? 0.3, lh = o.lipH ?? 1.6, b = shell.bounds, big = 1000;
      let base, top, zUnder = zSplit;
      if (style === 'lip' || style === 'rabbet') [base, top] = K2.splitLid(shell, e, zSplit, Object.assign({}, o, { joint: style === 'rabbet' ? 'rabbet' : undefined }));
      else if (style === 'skirt') {
        if (!o.outer) throw new Error("lid style 'skirt' needs outer (the body outline)");
        const st = o.step ?? Math.max(0.6, (rules.minWall || 1));
        const ring = (inOff, z0, h) => difference(extrude(o.outer.offset(5), h).translate([0, 0, z0]), extrude(o.outer.offset(-inOff), h + 2).translate([0, 0, z0 - 1]));
        const below = intersection(shell, cube([b.size[0] + 4, b.size[1] + 4, zSplit - b.min[2] + 2]).translate([b.min[0] - 2, b.min[1] - 2, b.min[2] - 2]));
        const above = intersection(shell, cube([b.size[0] + 4, b.size[1] + 4, b.max[2] - zSplit + 2]).translate([b.min[0] - 2, b.min[1] - 2, zSplit]));
        base = difference(below, ring(st, zSplit - lh, lh + 0.01));
        top = union(above, intersection(shell, ring(st - fit, zSplit - lh, lh + 0.01)));
        features.push({ kind: 'lid skirt', node: ring(st, zSplit - lh, lh).node, width: st });
      } else if (style === 'inset') {
        if (!o.inner) throw new Error("lid style 'inset' needs inner (the hollow outline)");
        const lidT = o.lidT ?? Math.max(rules.minWall || 1, 1.6), ledge = o.ledge ?? 1.2, zt = b.max[2], z0 = zt - lidT;
        const plate = extrude(o.inner.offset(-fit), lidT + 0.01).translate([0, 0, z0]);
        const rim = difference(extrude(o.inner.offset(0.01), 1.2).translate([0, 0, z0 - 1.2]), extrude(o.inner.offset(-ledge), 4).translate([0, 0, z0 - 2]));
        base = union(difference(shell, extrude(o.inner, lidT + 2).translate([0, 0, z0])), rim);
        top = intersection(union(shell, extrude(o.inner, lidT).translate([0, 0, z0])), plate);
        zUnder = z0;
        features.push({ kind: 'ledge', node: rim.node, width: ledge });
        const ib = o.inner.bounds; intended.push({ side: 'top', at: [(ib[0] + ib[2]) / 2, (ib[1] + ib[3]) / 2, zt], what: 'inset lid joint (the fit gap round the plate)', r: Math.hypot(ib[2] - ib[0], ib[3] - ib[1]) / 2 + 2 });
      } else throw new Error("lid style: 'lip', 'rabbet', 'skirt' or 'inset'");
      for (const pd of o.pads || []) {
        const [x, y] = pd.at || [0, 0], h = num(pd.h ?? 2, 'pad h'), blk = pd.d ? cylinder({ d: pd.d, h: h + 0.3 }) : cube([pd.w ?? 6, pd.l ?? 6, h + 0.3], { center: false }).translate([-(pd.w ?? 6) / 2, -(pd.l ?? 6) / 2, 0]);
        top = union(top, blk.translate([x, y, zUnder - h]));
      }
      return [base, top];
    };
    // concave underside following the wrist (cylinder along X); returns the cutter and the lift at the ends
    K2.wristCurve = (L, zLow, R = 34) => { const sag = R - Math.sqrt(Math.max(0, R * R - (L / 2) * (L / 2))); return { sag, cutter: cylinder({ r: R, h: 400, center: true, fn: 160 }).rotate([0, 90, 0]).translate([0, 0, zLow + sag - R]) }; };
    // where the body outline is at a given x (largest y for side +1, smallest for -1), in the outline's own coordinates
    K2.edgeAt = (shape2d, x, side = 1) => {
      const P = shape2d.pts, ys = [];
      for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, yi] = P[i], [xj, yj] = P[j]; if ((xi <= x) !== (xj <= x) && xi !== xj) ys.push(yi + (yj - yi) * (x - xi) / (xj - xi)); }
      return ys.length ? (side > 0 ? Math.max(...ys) : Math.min(...ys)) : null;
    };
    // strap attachments on the ±Y ends: 'slot' (strap loops through), 'pins' (watch lugs with spring-bar holes), 'bar' (closed loop bar).
    // With o.outline (the body outline in the same local frame) each lug reaches into the body, so it is one solid with it.
    K2.strapLugs = (o) => {
      const { W, L, z, strap = 22, style = 'slot', t = 4.5, cx = 0, cy = 0, outline = null, barHole = 1.3, contact = false } = o, add = [], cut = [];
      const reach = (x, s) => { const e = outline ? K2.edgeAt(outline, x, s) : null; return e == null ? cy : e - s * 1.5; };   // 1.5 mm into the body
      for (const s of [-1, 1]) {
        const yE = cy + s * L / 2;
        if (style === 'pins') {
          for (const sx of [-1, 1]) {
            const x = cx + sx * (strap / 2 + 1.6), y0 = Math.min(s * reach(x - 1.6, s), s * reach(x + 1.6, s), s * (yE - s * 1)) * s, y1 = yE + s * 7;
            add.push(roundedBox([3.2, Math.abs(y1 - y0), t], 1.2).translate([x, (y0 + y1) / 2, z]));
          }
          cut.push(cylinder({ d: barHole, h: strap + 12, center: true, fn: 16 }).rotate([0, 90, 0]).translate([cx, yE + s * 5, z]));
          // strap-as-ground: a wire channel from one lug's bar hole, inside the lug and the wall, into the case
          if (contact && s > 0) cut.push(K2.wireChannel([cx + strap / 2 + 1.6, yE + s * 5, z], [cx + strap / 2 + 1.6, yE - s * 4, z + 0.5], o.contactD ?? 1.0));
        } else {
          const depth = style === 'bar' ? 5 : 7, hw = strap / 2 + 3;
          const y0 = Math.min(s * reach(cx - hw, s), s * reach(cx + hw, s), s * reach(cx, s), s * (yE - s * 1)) * s, y1 = yE + s * (depth - 1);
          add.push(roundedBox([strap + 6, Math.abs(y1 - y0), t], Math.min(1.5, t / 2 - 0.05)).translate([cx, (y0 + y1) / 2, z]));
          cut.push(cube([strap + 1, style === 'bar' ? 2 : 2.6, t + 2], { center: true }).translate([cx, yE + s * (depth - 2.8), z]));
        }
      }
      return { add: union(add), cut: union(cut) };
    };
    // snap-electrode studs: through holes with a thicker boss around each (skin side = bottom)
    K2.snapStuds = (pts, zb, zTopBoss, d = 4.2, boss = 10) => ({ add: union(pts.map(([x, y]) => cylinder({ d: boss, h: zTopBoss - zb + 0.01 }).translate([x, y, zb]))), cut: union(pts.map(([x, y]) => cylinder({ d, h: 40, center: true }).translate([x, y, zb]))) });
    // spring belt / harness clip on the back
    K2.beltClip = (W, L, zb, cx = 0, cy = 0) => {
      const w = Math.min(W * 0.7, 30), gap = 2.2, th = 2;
      return union(cube([w, L * 0.85, th]).translate([cx - w / 2, cy - L * 0.85 / 2, zb - gap - th]), cube([w, 4, gap + 0.5]).translate([cx - w / 2, cy + L * 0.85 / 2 - 4, zb - gap - 0.2]));
    };
    // lanyard / key-ring loop on the +Y end
    K2.loop = (L, z, cx = 0, cy = 0, R = 4, r = 1.6) => torus({ R, r, fn: 48, fn2: 16 }).translate([cx, cy + L / 2 + R - r * 0.5, z]);   // flat ring tab (prints without support)
    // ventilation slots through the lid
    // (only through the lid: from just below the split to above the top, never down into the base and its floor)
    K2.ventSlots = (e, zt, n = 5) => { intended.push({ side: 'top', at: [e.cx, e.cy, zt], what: 'vent slots', r: Math.min(e.w * 0.5, 30) / 2 + n * 1.8 + 2 }); const w = Math.min(e.w * 0.5, 30), z0 = Math.min(e.zTop, zt - 1) - 0.3, h = zt + 2 - z0, list = []; for (let k = 0; k < n; k++) list.push(roundedBox([w, 1.4, h], 0.6).translate([e.cx, e.cy - (n - 1) * 1.8 + k * 3.6, z0 + h / 2])); return union(list); };
    // mounting ears with screw holes on ±X
    K2.mountEars = (W, zb, cx = 0, cy = 0, th = 3) => { const add = [], cut = []; for (const s of [-1, 1]) { add.push(roundedBox([12, 14, th], 1.2).translate([cx + s * (W / 2 + 5), cy, zb + th / 2])); cut.push(cylinder({ d: 3.4, h: 20, center: true }).translate([cx + s * (W / 2 + 6), cy, zb])); } return { add: union(add), cut: union(cut) }; };
    // ---------- more modelling helpers ----------
    // the cell as a solid (show it, or subtract it with a clearance for a pocket); a floor cradle that keeps it in place
    K2.batteryBox = (e, c = 0) => {
      const B = e && e.battery; if (!B) throw new Error('batteryBox(e): call envelope({battery: id}) first');
      const tip = s => B.rot ? s.translate(B.pivot.map(v => -v)).rotate(B.rot).translate(B.pivot) : s;
      if (B.shape === 'coin') return tip(cylinder({ d: B.w + 2 * c, h: B.t + 2 * c }).translate([B.cx, B.cy, B.z0 - c]));
      if (B.shape === 'cyl') return tip(cylinder({ d: B.t + 2 * c, h: Math.max(B.w, B.l) + 2 * c, center: true }).rotate(B.w > B.l ? [0, 90, 0] : [90, 0, 0]).translate([B.cx, B.cy, (B.z0 + B.z1) / 2]));
      return tip(roundedBox([B.w + 2 * c, B.l + 2 * c, B.t + 2 * c], Math.min(0.8, B.t / 2 - 0.01 + c)).translate([B.cx, B.cy, (B.z0 + B.z1) / 2]));
    };
    K2.batteryCradle = (e, o = {}) => {
      const B = e && e.battery; if (!B || B.place === 'above') return null;
      const c = o.clearance ?? 0.4, w = o.wall ?? 1.2, h = Math.min(o.height ?? 2.5, B.t * 0.7) + 0.3, z = e.zFloor - 0.3;   // 0.3 mm into the floor: one solid with it
      if (B.shape === 'coin') return difference(cylinder({ d: B.w + 2 * (c + w), h }), cylinder({ d: B.w + 2 * c, h: h + 2 }).translate([0, 0, -1]), cube([B.w * 0.5, B.w + 10, h + 2], { center: true }).translate([0, 0, h / 2])).translate([B.cx, B.cy, z]);   // open on two sides for the tabs
      const W = B.w + 2 * c, L = B.l + 2 * c, a = Math.min(8, W / 3), b = Math.min(8, L / 3), ribs = [];
      // L-shaped corner ribs (the long leg covers the corner, so each L is one piece)
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) ribs.push(cube([a + w, w, h]).translate([sx < 0 ? -W / 2 - w : W / 2 - a, sy < 0 ? -L / 2 - w : L / 2, 0]), cube([w, b, h]).translate([sx < 0 ? -W / 2 - w : W / 2, sy < 0 ? -L / 2 : L / 2 - b, 0]));
      return union(ribs).translate([B.cx, B.cy, z]);
    };
    // text from the stroke font (A-Z, 0-9, - . / + : # ...): flat on XY, z 0 ... depth, centred on [0, 0]. Emboss: union it onto a
    // face; engrave: subtract it. o: {size (cap height, mm), depth, stroke (line width), align: 'center' | 'left' | 'right', mirror}
    // 2D text (a region): strokes of the stroke font; minRidge closes the material between strokes that would be thinner
    // than it (the inside of sharp corners, letters too close) — what a print service shows red under an engraving
    K2.text2d = (str, o = {}) => {
      need2fast('text2d');
      const size = num(o.size ?? 5, 'size'), sw = Math.max(0.3, num(o.stroke ?? Math.max(0.4, size * 0.14), 'stroke')), r = sw / 2;
      const lines = StrokeFont.strokeText(String(str), 0, 0, size, o.align === 'left' ? 'start' : o.align === 'right' ? 'end' : 'middle', !!o.mirror), segs = [];
      const dot = api2.circle(r, { fn: 16 });
      for (const L of lines) {
        if (L.length === 1) { segs.push(dot.translate([L[0][0], -L[0][1] - size / 2])); continue; }
        for (let i = 0; i < L.length - 1; i++) { const a = L[i], b = L[i + 1]; segs.push(api2.hull2d(dot.translate([a[0], -a[1] - size / 2]), dot.translate([b[0], -b[1] - size / 2]))); }
      }
      if (!segs.length) throw new Error('text2d(): nothing to write');
      let reg = bool2('union', segs);
      const mr = o.minRidge ?? 0; if (mr > 0) reg = reg.offset(mr / 2).offset(-mr / 2);
      // hairline slits (letters that nearly touch, stroke joints) are cut away: no 0.02 mm gaps in the text
      return reg.offset(-0.06).offset(0.06);
    };
    // cut a 2D shape / region / text into the face at o.at = [x, y, zFace] (top face: into -z; o.face 'bottom': into +z), depth deep.
    // minRidge (default: the project rule) closes ridges between the grooves narrower than it.
    K2.engrave = (shape, what, o = {}) => {
      const depth = num(o.depth ?? 0.6, 'depth'), [x, y, z] = o.at ? vec3(o.at, 'at') : [0, 0, 0], mr = o.minRidge ?? rules.minRidge;
      let reg = typeof what === 'string' ? K2.text2d(what, { size: o.size ?? 4 }) : what; if (!is2(reg)) throw new Error('engrave(): give a 2D shape, a region or a string');
      if (mr > 0 && MK) reg = (reg instanceof Region2D ? reg : bool2('union', [reg])).offset(mr / 2).offset(-mr / 2).offset(-0.06).offset(0.06);
      const cut = extrude(reg, depth + 0.02).translate([x, y, o.face === 'bottom' ? z - 0.02 : z - depth]);
      features.push({ kind: 'engraving', name: o.name || (typeof what === 'string' ? what : ''), node: cut.node, depth });
      return difference(shape, cut);
    };
    K2.text = (str, o = {}) => {
      if (MK) { const reg = K2.text2d(str, Object.assign({ minRidge: rules.minRidge }, o)); return extrude(reg, num(o.depth ?? 0.6, 'depth')); }
      const size = num(o.size ?? 5, 'size'), depth = num(o.depth ?? 0.6, 'depth'), sw = Math.max(0.3, num(o.stroke ?? Math.max(0.4, size * 0.14), 'stroke')), r = sw / 2;
      const lines = StrokeFont.strokeText(String(str), 0, 0, size, o.align === 'left' ? 'start' : o.align === 'right' ? 'end' : 'middle', !!o.mirror), segs = [];
      const dot = api2.circle(r, { fn: 10 });
      for (const L of lines) {
        if (L.length === 1) { segs.push(extrude(dot.translate([L[0][0], -L[0][1] - size / 2]), depth)); continue; }
        for (let i = 0; i < L.length - 1; i++) { const a = L[i], b = L[i + 1]; segs.push(extrude(api2.hull2d(dot.translate([a[0], -a[1] - size / 2]), dot.translate([b[0], -b[1] - size / 2])), depth)); }
      }
      if (!segs.length) throw new Error('text(): nothing to write');
      return union(segs);
    };
    // hexagon vent / speaker grille cutter: a w x l field of hexagonal holes (cell = across flats), h tall, centred on o.at = [x, y, z]
    K2.honeycomb = (w, l, o = {}) => {
      const cell = o.cell ?? 4, wall = o.wall ?? 1.2, h = o.h ?? 20, [x, y, z] = o.at || [0, 0, 0], R = cell / Math.sqrt(3), dx = cell + wall, dy = (cell + wall) * Math.sqrt(3) / 2, L = [];
      const hex = extrude(api2.polygon([0, 60, 120, 180, 240, 300].map(a => [R * Math.cos((a + 30) * Math.PI / 180), R * Math.sin((a + 30) * Math.PI / 180)])), h, { center: true });
      for (let j = 0, yy = -l / 2 + R; yy <= l / 2 - R + 1e-6; j++, yy += dy) for (let xx = -w / 2 + cell / 2 + (j % 2 ? dx / 2 : 0); xx <= w / 2 - cell / 2 + 1e-6; xx += dx) L.push(hex.translate([x + xx, y + yy, z]));
      if (!L.length) throw new Error('honeycomb(): the field is smaller than one cell');
      return union(L);
    };
    // screw boss: {x, y, z0 (bottom), h, screw: 'M2' | 'M2.5' | 'M3', insert: true (heat-set insert hole) | false (self-tapping pilot)} -> {add, cut}
    K2.screwBoss = (o = {}) => {
      const S = { M2: [1.6, 3.2], 'M2.5': [2.0, 3.6], M3: [2.5, 4.0] }[o.screw || 'M3']; if (!S) throw new Error("screwBoss(): screw must be 'M2', 'M2.5' or 'M3'");
      const hole = o.insert ? S[1] : S[0], d = o.d ?? hole + 3.2, h = num(o.h ?? 5, 'h'), x = o.x || 0, y = o.y || 0, z0 = o.z0 || 0, depth = o.insert ? Math.min(h, 5) : h;
      return { add: cylinder({ d, h }).translate([x, y, z0]), cut: cylinder({ d: hole, h: depth + 0.01 }).translate([x, y, z0 + h - depth]) };
    };
    // countersunk screw hole down through a plate whose top is at z: {d (shank), head, depth}
    K2.countersink = (x, y, z, o = {}) => { const d = o.d ?? 3.2, hd = o.head ?? d * 2, dep = o.depth ?? 20; return union(cylinder({ d, h: dep }).translate([x, y, z - dep]), cylinder({ d1: d, d2: hd, h: (hd - d) / 2 + 0.01 }).translate([x, y, z - (hd - d) / 2])); };
    // measurements while modelling: smallest distance between two shapes (searched up to max mm), volume / area / bounds
    K2.gap = (a, b, max = 10) => { if (!MK) throw new Error('gap() needs the fast 3D kernel'); return +evalM(need3(a, 'gap')).minGap(evalM(need3(b, 'gap')), max).toFixed(3); };
    K2.measure = s => {
      const n = need3(s, 'measure');
      if (MK) { const m = evalM(n), b = mBounds(m); return { volume_mm3: +m.volume().toFixed(2), area_mm2: +m.surfaceArea().toFixed(2), min: b.slice(0, 3), max: b.slice(3), size: [b[3] - b[0], b[4] - b[1], b[5] - b[2]] }; }
      const P = evalNode(n), b = bboxOf(P); return { volume_mm3: +volumeOf(P).toFixed(2), min: b.slice(0, 3), max: b.slice(3), size: [b[3] - b[0], b[4] - b[1], b[5] - b[2]] };
    };
    K2.battery = id => Enclosure.battery(id);
    // ---- skin electrodes: a flat metal plate (cut by laser from sheet), the recess it sits in (following a wrist curve) and the
    // wire hole behind it, in one call. The plate becomes a 'metal' part: exported as DXF (cut lines) + STEP, on a panel with the others.
    const electrodes = [];
    K2.electrode = (o = {}) => {
      const name = String(o.name || 'electrode' + (electrodes.length + 1)).replace(/[^\w.-]+/g, '_');
      const [x, y] = o.at || [0, 0], plateT = o.plateT ?? 0.5, proud = o.proud ?? 0.1, clr = o.clearance ?? 0.15, hole = o.hole ?? 1.6, z = num(o.z ?? 0, 'z');
      const round = o.shape === 'circle' || o.d != null;
      let prof = round ? P.circle((o.d ?? 10) / 2) : P.rect(o.w ?? 10, o.h ?? 10, o.r ?? 1.0);
      let s2 = round ? api2.circle((o.d ?? 10) / 2, { fn: 64 }) : api2.roundedRect(o.w ?? 10, o.h ?? 10, o.r ?? 1.0);
      if (o.rotate) { s2 = s2.rotate(o.rotate); prof = P.rotate(prof, o.rotate); }
      const flat = { loops: [prof], open: [] };   // exact: lines, arcs, circles (the DXF / STEP keep them)
      if (o.tab) {   // lanced wire tab: a U-shaped cut over the wire hole; the tab is bent into the hole and the wire crimped / wrapped on it
        const tw = o.tab.w ?? 2.4, tl = o.tab.l ?? 3.2, ty = o.tab.at ?? 0, u = [[-tw / 2, ty - tl / 2], [-tw / 2, ty + tl / 2], [tw / 2, ty + tl / 2], [tw / 2, ty - tl / 2]];
        let c = u.slice(0, 3).map((a, i) => ({ t: 'L', a, b: u[i + 1] })); if (o.rotate) c = P.rotate(c, o.rotate);
        flat.open.push(c);
      }
      const fp = s2.translate([x, y]), fpC = s2.offset(clr).translate([x, y]), prism = s => extrude(s, 1000).translate([0, 0, -500]);
      // face: 'bottom' (skin side, default: the plate looks down) or 'top' (a finger / lid plate: it looks up)
      const face = o.face === 'top' ? 'top' : 'bottom', hx = x + (o.holeAt ? o.holeAt[0] : 0), hy = y + (o.holeAt ? o.holeAt[1] : 0);
      let plate, pocket, zIn;
      if (o.curve && face === 'top') {   // a convex top following a cylinder (axis below): the plate is the outer skin of it
        const R = num(o.curve.R, 'curve.R'), az = num(o.curve.axisZ, 'curve.axisZ'), along = o.curve.along || 'y', c0 = along === 'y' ? (o.curve.y0 || 0) : (o.curve.x0 || 0);
        const cyl = r => (along === 'y' ? cylinder({ r, h: 1000, center: true, fn: 192 }).rotate([0, 90, 0]).translate([0, c0, az]) : cylinder({ r, h: 1000, center: true, fn: 192 }).rotate([90, 0, 0]).translate([c0, 0, az]));
        plate = intersection(prism(fp), difference(cyl(R + proud), cyl(R + proud - plateT))).trim([0, 0, 1], az);
        pocket = intersection(prism(fpC), difference(cyl(R + 20), cyl(R + proud - plateT - 0.05))).trim([0, 0, 1], az);
        const d = along === 'y' ? hy - c0 : hx - c0, Rp = R + proud - plateT; zIn = az + Math.sqrt(Math.max(0, Rp * Rp - d * d));
      } else if (face === 'top') {   // flat top at z: the plate stands proud of it by `proud`
        plate = extrude(fp, plateT).translate([0, 0, z + proud - plateT]);
        pocket = extrude(fpC, plateT - proud + 0.05 + 5).translate([0, 0, z + proud - plateT - 0.05]);
        zIn = z + proud - plateT;
      } else if (o.curve) {   // the skin side follows a cylinder (wrist): {R, axisZ, along: 'y' (strap along Y, axis along X) | 'x', y0 / x0 = axis position}
        const R = num(o.curve.R, 'curve.R'), az = num(o.curve.axisZ, 'curve.axisZ'), along = o.curve.along || 'y', c0 = along === 'y' ? (o.curve.y0 || 0) : (o.curve.x0 || 0);
        const cyl = r => (along === 'y' ? cylinder({ r, h: 1000, center: true, fn: 192 }).rotate([0, 90, 0]).translate([0, c0, az]) : cylinder({ r, h: 1000, center: true, fn: 192 }).rotate([90, 0, 0]).translate([c0, 0, az]));
        // only the skin side of the cylinder (above its axis: the body sits on the wrist)
        plate = intersection(prism(fp), difference(cyl(R - proud + plateT), cyl(R - proud))).trim([0, 0, 1], az);
        pocket = intersection(prism(fpC), cyl(R - proud + plateT + 0.05)).trim([0, 0, 1], az);
        const d = along === 'y' ? hy - c0 : hx - c0, Rp = R - proud + plateT; zIn = az + Math.sqrt(Math.max(0, Rp * Rp - d * d));
      } else {   // flat skin side at z (the plate stands proud of it by `proud`)
        plate = extrude(fp, plateT).translate([0, 0, z - proud]);
        pocket = extrude(fpC, plateT - proud + 0.05 + 5).translate([0, 0, z - 5]);
        zIn = z - proud + plateT;
      }
      // the wire hole starts 0.5 mm inside the recess: in a curved recess the ceiling drops toward the hole's edge, and a
      // hole started at the centre's height leaves a knife-edge sliver there
      const thr = o.through ?? 4, wire = hole > 0 ? (face === 'top' ? cylinder({ d: hole, h: thr + 0.5 }).translate([hx, hy, zIn + 0.5 - thr - 0.5]) : cylinder({ d: hole, h: thr + 0.5 }).translate([hx, hy, zIn - 0.5])) : null;
      const cut = wire ? union(pocket, wire) : pocket;
      lib.part(name, plate, { kind: 'metal', thickness: plateT, color: o.color || '#c9ccd1', explode: o.explode || [0, 0, -8] });
      Object.assign(parts[parts.length - 1], { flat, face, hole: hole > 0 ? { at: o.holeAt ? [+o.holeAt[0], +o.holeAt[1]] : [0, 0], d: hole } : null });
      if (o.tab) kitWarn.push(`electrode ${name}: the lanced wire tab (strip and slot under 5 mm / the sheet thickness) makes JLCCNC refuse or hand-quote the part — leave tab out and join the wire on the back over the hole`);
      electrodes.push({ name, pts: fp.pts, at: [x, y], min: o.minGap ?? 5, face, z: zIn });
      if (wire) intended.push({ side: face, at: [hx, hy, zIn], what: `${name} wire hole (${face === 'top' ? 'under' : 'behind'} the plate)`, r: 4 });
      return { cut, plate, name, flat, outline: fp };
    };
    // adhesive for skin tape (e.g. 3M 2476P): the underside outline shrunk by inset, minus windows (electrodes) grown by
    // windowGrow — a flat 'adhesive' part: exported as DXF and a 1:1 printable PDF template (A4, 50 mm check line)
    K2.adhesive = (o = {}) => {
      if (!o.outline || !is2(o.outline)) throw new Error('adhesive({outline: 2D shape of the underside, inset, windows, windowGrow, z})');
      const name = String(o.name || 'adhesive').replace(/[^\w.-]+/g, '_'), inset = o.inset ?? 0.8, grow = o.windowGrow ?? 1;
      let reg = bool2('union', [o.outline]).offset(-inset);
      const wins = (o.windows || []).map(w => (w && w.outline) || w).filter(is2);
      if (wins.length) reg = bool2('difference', [reg, ...wins.map(w => bool2('union', [w]).offset(grow))]);
      const sheet = extrude(reg, o.thickness ?? 0.2).translate([0, 0, (o.z ?? 0) - (o.thickness ?? 0.2)]);
      lib.part(name, sheet, { kind: 'reference', color: o.color || '#f2e6b3', explode: [0, 0, -14] });
      const pt = parts[parts.length - 1]; pt.adhesive = true; pt.flat = { loops: reg.polys.map(l => P.poly(l)), open: [] };
      return { region: reg, shape: sheet };
    };
    // a round channel from a to b (wires, light pipes): cut it out of the body
    K2.wireChannel = (a, b, d = 1.2) => hull(sphere({ d, fn: 16 }).translate(vec3(a, 'a')), sphere({ d, fn: 16 }).translate(vec3(b, 'b')));
    // end faces square to the skin: keep only the wedge ±angle° around the top of a wrist curve (no knife-edge tail tips)
    K2.radialEnds = (shape, o = {}) => {
      const a = num(o.angle ?? 30, 'angle') * Math.PI / 180, az = num(o.axisZ, 'axisZ'), along = o.along || 'y', c0 = along === 'y' ? (o.y0 || 0) : (o.x0 || 0);
      const n1 = along === 'y' ? [0, -Math.cos(a), Math.sin(a)] : [-Math.cos(a), 0, Math.sin(a)], n2 = along === 'y' ? [0, Math.cos(a), Math.sin(a)] : [Math.cos(a), 0, Math.sin(a)];
      const p0 = along === 'y' ? [0, c0, az] : [c0, 0, az], d = n => n[0] * p0[0] + n[1] * p0[1] + n[2] * p0[2];
      return need3(shape, 'radialEnds') && shape.trim(n1, d(n1)).trim(n2, d(n2));
    };
    // declare an opening as intended (side: left | right | front | back | top | bottom, at [x, y, z], r = how near counts),
    // so the openings check does not report it — vents, wire holes, electrode / stud holes, a speaker grille …
    K2.opening = (side, at, what = 'opening', r = 5) => { intended.push({ side, at: vec3(at, 'at'), what: String(what), r: +r || 5 }); return null; };
    const names = Object.keys(lib);
    let ret;
    try {
      // the script runs in its own inner scope, so its own variables may reuse kit names (cavity, loop, …)
      const fn = new Function(...names, 'console', '"use strict"; return (() => {\n' + code + '\n})();');
      ret = fn(...names.map(k => lib[k]), { log: lib.log, warn: lib.log, error: lib.log });
      if (!parts.length && ret instanceof Shape) lib.part('model', ret);
      if (!parts.length) throw new Error('The script made no parts — call part("name", shape) (or return a shape).');
      if (opts.shapes && opts.shapes.length) applyDesign(opts.shapes, parts, lib, intended, logs);
      for (const p of parts) {
        if (MK) {
          p.m = evalM(p.shape.node);
          // slivers under 1 mm³ left by cuts that graze a curved wall are debris, not features: drop them
          const d = p.m.decompose(); d.forEach(kept);
          // (a sealed hollow is a second surface with negative volume — it is not a sliver: compare by size)
          if (d.length > 1) { const big = d.filter(x => Math.abs(x.volume()) >= 1); if (big.length && big.length < d.length) { p.m = kept(MF.Manifold.compose(big)); p.dropped = d.length - big.length; } }
          // collapse zero-area triangles (three points in a row): dropping them later would leave hairline cracks in the STL / STEP
          try { const sm = kept(p.m.simplify(1e-4)); if (!sm.isEmpty() && Math.abs(sm.volume() - p.m.volume()) < 1e-3 * Math.max(1, p.m.volume())) p.m = sm; } catch (e) { }
          p.polys = p.m.isEmpty() ? [] : polysOfM(p.m);
        }
        else p.polys = K().fillHoles(K().zipSeams(K().repair(p.shape.polys.map(q => q.clone()))));
        if (!p.polys.length) throw new Error(`part "${p.name}" is empty (check the boolean operations / positions)`);
      }
    } catch (e) {
      // errors from inside the WASM kernel (not the script's own): the caller retries with the BSP kernel
      if (MK && (!(e instanceof Error) || /Binding|wasm|memory|abort|ManifoldError|deleted|RuntimeError/i.test(String(e && (e.name + e.message))))) { budget = null; K().guard.deadline = 0; HQ3 = false; K().setQuality('preview'); throw Object.assign(new Error('3D kernel: ' + (e && e.message || e)), { kernel: true }); }
      const m = String(e && e.stack || '').match(/eval at [^\n]*?<anonymous>:(\d+):(\d+)/) || String(e && e.stack || '').match(/^\s*at [^\n(]*\(?<anonymous>:(\d+):(\d+)/m);
      const err = new Error((e && e.message || String(e)) + (m ? ` (script line ${+m[1] - 3})` : ''));
      err.line = m ? +m[1] - 3 : null; err.logs = logs; budget = null; K().guard.deadline = 0; HQ3 = false; K().setQuality('preview'); throw err;
    }
    // fit report: shells must not cut into the board or the components
    const report = { collisions: [], warnings: kitWarn.slice() };
    const bats = extras.filter(x => x.kind === 'battery');
    if (pcb && opts.check !== false && MK) {
      // exact: volume of each printed part inside the board / each component box / the battery
      const M3 = MF.Manifold, tg = [{ with: 'PCB', m: xsec(new Shape2D(pcb.outline)).extrude(pcb.thickness) }];
      kept(tg[0].m);
      for (const q of pcb.parts.slice(0, 300)) { const w = Math.max(0.05, q.x1 - q.x0), d = Math.max(0.05, q.y1 - q.y0), h = Math.max(0.05, q.h); tg.push({ with: q.ref, m: kept(M3.cube([w, d, h]).translate([q.x0, q.y0, q.side === 'top' ? pcb.thickness : -h])) }); }
      for (const b of bats) if (b.rot) tg.push({ with: 'battery ' + b.name, m: evalM(K2.batteryBox({ battery: b }, 0).node) }); else tg.push({ with: 'battery ' + b.name, m: b.shape === 'coin' ? kept(kept(M3.cylinder(b.t, b.w / 2, b.w / 2, 64)).translate([b.cx, b.cy, b.z0]))
        : b.shape === 'cyl' ? kept(kept(kept(M3.cylinder(Math.max(b.w, b.l), b.t / 2, b.t / 2, 64, true)).rotate(b.w > b.l ? [0, 90, 0] : [90, 0, 0])).translate([b.cx, b.cy, (b.z0 + b.z1) / 2])) : kept(M3.cube([b.w, b.l, b.t]).translate([b.x0, b.y0, b.z0])) });
      for (const p of parts) {
        const pb = mBounds(p.m);
        for (const t of tg) {
          if (!overlap(pb, mBounds(t.m))) continue;
          const v = kept(p.m.intersect(t.m)).volume();
          if (v > 0.5) report.collisions.push({ part: p.name, with: t.with, overlap_mm3: +v.toFixed(1) });
        }
      }
    } else if (pcb && opts.check !== false) {
      // sample points inside the board and each component box; count those that fall inside a printed part
      const inPoly = (x, y, P) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, yi] = P[i], [xj, yj] = P[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
      const targets = [];
      { const xs = pcb.outline.map(q => q[0]), ys = pcb.outline.map(q => q[1]), st = Math.max(0.8, Math.sqrt(pcb.w * pcb.h / 600)), pts = [];
        for (let x = Math.min(...xs) + st / 2; x < Math.max(...xs); x += st) for (let y = Math.min(...ys) + st / 2; y < Math.max(...ys); y += st) if (inPoly(x, y, pcb.outline)) pts.push([x, y, pcb.thickness / 2]);
        targets.push({ with: 'PCB', pts, cell: st * st * pcb.thickness }); }
      for (const p of pcb.parts.slice(0, 120)) {
        const nx = 5, ny = 5, nz = 3, w = p.x1 - p.x0, d = p.y1 - p.y0, z0 = p.side === 'top' ? pcb.thickness : -p.h, pts = [];
        for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) pts.push([p.x0 + w * (i + 0.5) / nx, p.y0 + d * (j + 0.5) / ny, z0 + p.h * (k + 0.5) / nz]);
        targets.push({ with: p.ref, pts, cell: w * d * p.h / (nx * ny * nz) });
      }
      for (const b of bats) { const pts = []; for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) for (let k = 0; k < 3; k++) { const P = [b.x0 + b.w * (i + 0.5) / 5, b.y0 + b.l * (j + 0.5) / 5, b.z0 + b.t * (k + 0.5) / 3], r = b.shape === 'coin' ? Math.hypot(P[0] - b.cx, P[1] - b.cy) / (b.w / 2) : b.shape === 'cyl' ? (b.w > b.l ? Math.hypot(P[1] - b.cy, P[2] - (b.z0 + b.z1) / 2) : Math.hypot(P[0] - b.cx, P[2] - (b.z0 + b.z1) / 2)) / (b.t / 2) : 0; if (r <= 1) pts.push(P); } targets.push({ with: 'battery ' + b.name, pts, cell: b.w * b.l * b.t / 75 }); }
      for (const p of parts) {
        const pb = bboxOf(p.polys), T = K().triangles(p.polys).map(([a, b, c]) => [a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z]);
        // bucket triangles on a Y-Z grid: a ray along X only meets the triangles of its own cell
        const cs = Math.max(0.5, Math.max(pb[4] - pb[1], pb[5] - pb[2]) / 64), grid = new Map();
        T.forEach((t, i) => {
          const y0 = Math.floor((Math.min(t[1], t[4], t[7]) - pb[1]) / cs), y1 = Math.floor((Math.max(t[1], t[4], t[7]) - pb[1]) / cs), z0 = Math.floor((Math.min(t[2], t[5], t[8]) - pb[2]) / cs), z1 = Math.floor((Math.max(t[2], t[5], t[8]) - pb[2]) / cs);
          for (let a = y0; a <= y1; a++) for (let b = z0; b <= z1; b++) { const k = a * 4096 + b; let g = grid.get(k); if (!g) grid.set(k, g = []); g.push(t); }
        });
        const inside = (x, y, z) => { // ray along +X (slightly tilted) — odd number of crossings = inside
          if (x < pb[0] || x > pb[3] || y < pb[1] || y > pb[4] || z < pb[2] || z > pb[5]) return false;
          const dx = 1, dy = 1.3e-4, dz = 2.7e-4; let n = 0;
          for (const t of grid.get(Math.floor((y - pb[1]) / cs) * 4096 + Math.floor((z - pb[2]) / cs)) || []) {
            if (Math.max(t[0], t[3], t[6]) < x) continue;
            const e1x = t[3] - t[0], e1y = t[4] - t[1], e1z = t[5] - t[2], e2x = t[6] - t[0], e2y = t[7] - t[1], e2z = t[8] - t[2];
            const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x, det = e1x * px + e1y * py + e1z * pz;
            if (Math.abs(det) < 1e-12) continue;
            const inv = 1 / det, sx = x - t[0], sy = y - t[1], sz = z - t[2], u = (sx * px + sy * py + sz * pz) * inv; if (u < 0 || u > 1) continue;
            const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x, v = (dx * qx + dy * qy + dz * qz) * inv; if (v < 0 || u + v > 1) continue;
            if ((e2x * qx + e2y * qy + e2z * qz) * inv > 0) n++;
          }
          return (n & 1) === 1;
        };
        for (const tg of targets) {
          let hit = 0; for (const q of tg.pts) if (inside(q[0], q[1], q[2])) hit++;
          const v = hit * tg.cell;
          if (hit && v > 0.5) report.collisions.push({ part: p.name, with: tg.with, overlap_mm3: +v.toFixed(1) });
        }
        if (Date.now() > budget) { report.warnings.push('fit check stopped early (time limit)'); break; }
      }
    }
    // containment: the board and every part must sit inside the enclosure. A point is outside when it can see out
    // along 2 or more of the 6 axis directions (1 is allowed: the way out through an LED / button window).
    if (pcb && opts.check !== false && Date.now() < budget) {
      const T = []; for (const p of parts) for (const [a, b, c] of K().triangles(p.polys)) T.push([a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z]);
      const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (const t of T) for (let k = 0; k < 9; k++) { const ax = k % 3; bb[ax] = Math.min(bb[ax], t[k]); bb[ax + 3] = Math.max(bb[ax + 3], t[k]); }
      const grids = [0, 1, 2].map(ax => {
        const [u, v] = [[1, 2], [0, 2], [0, 1]][ax], cs = Math.max(0.5, Math.max(bb[u + 3] - bb[u], bb[v + 3] - bb[v]) / 80), g = new Map();
        T.forEach(t => { const u0 = Math.floor((Math.min(t[u], t[u + 3], t[u + 6]) - bb[u]) / cs), u1 = Math.floor((Math.max(t[u], t[u + 3], t[u + 6]) - bb[u]) / cs), v0 = Math.floor((Math.min(t[v], t[v + 3], t[v + 6]) - bb[v]) / cs), v1 = Math.floor((Math.max(t[v], t[v + 3], t[v + 6]) - bb[v]) / cs); for (let a = u0; a <= u1; a++) for (let b = v0; b <= v1; b++) { const k = a * 4096 + b; let L = g.get(k); if (!L) g.set(k, L = []); L.push(t); } });
        return { u, v, cs, g };
      });
      const hits = (P, ax, sgn) => {
        const G = grids[ax], L = G.g.get(Math.floor((P[G.u] - bb[G.u]) / G.cs) * 4096 + Math.floor((P[G.v] - bb[G.v]) / G.cs)); if (!L) return false;
        const d = [0, 0, 0]; d[ax] = sgn; d[(ax + 1) % 3] = 1.3e-4; d[(ax + 2) % 3] = 2.1e-4;
        for (const t of L) {
          const e1 = [t[3] - t[0], t[4] - t[1], t[5] - t[2]], e2 = [t[6] - t[0], t[7] - t[1], t[8] - t[2]];
          const px = d[1] * e2[2] - d[2] * e2[1], py = d[2] * e2[0] - d[0] * e2[2], pz = d[0] * e2[1] - d[1] * e2[0], det = e1[0] * px + e1[1] * py + e1[2] * pz;
          if (Math.abs(det) < 1e-12) continue;
          const inv = 1 / det, sx = P[0] - t[0], sy = P[1] - t[1], sz = P[2] - t[2], uu = (sx * px + sy * py + sz * pz) * inv; if (uu < 0 || uu > 1) continue;
          const qx = sy * e1[2] - sz * e1[1], qy = sz * e1[0] - sx * e1[2], qz = sx * e1[1] - sy * e1[0], vv = (d[0] * qx + d[1] * qy + d[2] * qz) * inv; if (vv < 0 || uu + vv > 1) continue;
          if ((e2[0] * qx + e2[1] * qy + e2[2] * qz) * inv > 1e-6) return true;
        }
        return false;
      };
      // outside = sees out in 3+ directions, or straight through along one axis (both ways); seeing out through
      // one or two openings (a window above, a connector opening beside) is normal for an enclosed part
      const escapes = P => { let n = 0, through = false; for (let ax = 0; ax < 3; ax++) { let k = 0; for (const s of [-1, 1]) if (!hits(P, ax, s)) { n++; k++; } if (k === 2) through = true; } return through ? 9 : n >= 3 ? 9 : n; };
      const out = [];
      const pc = [pcb.outline.reduce((a, q) => a + q[0], 0) / pcb.outline.length, pcb.outline.reduce((a, q) => a + q[1], 0) / pcb.outline.length];
      const boardPts = pcb.outline.map(q => [q[0] + (pc[0] - q[0]) * 0.03, q[1] + (pc[1] - q[1]) * 0.03, pcb.thickness / 2]).concat([[pc[0], pc[1], pcb.thickness / 2]]);
      if (boardPts.some(P => escapes(P) >= 3)) out.push('PCB');
      for (const b of bats) if (escapes([b.cx, b.cy, (b.z0 + b.z1) / 2]) >= 3) out.push('battery');
      for (const p of pcb.parts) {
        if (p.plug && p.edge) continue;
        // the part's box is only an estimate (its corners stick out of curved walls and floors): it is outside when its
        // centre can see out, or most of a grid of points inside its box can; a few escaping points only mean it is close
        const z0 = p.side === 'top' ? pcb.thickness : -p.h, z1 = z0 + p.h, ix = (p.x1 - p.x0) * 0.2, iy = (p.y1 - p.y0) * 0.2, iz = Math.min(0.3, p.h * 0.2);
        const pts = [];
        for (const fx of [0, 0.5, 1]) for (const fy of [0, 0.5, 1]) for (const fz of [0, 1]) pts.push([p.x0 + ix + (p.x1 - p.x0 - 2 * ix) * fx, p.y0 + iy + (p.y1 - p.y0 - 2 * iy) * fy, z0 + iz + (p.h - 2 * iz) * fz]);
        const centre = escapes([p.cx, p.cy, (z0 + z1) / 2]) >= 3, esc = pts.filter(P => escapes(P) >= 3).length;
        if (centre || esc > pts.length / 2) out.push(p.ref);
        else if (esc) (report.near_wall = report.near_wall || []).push(`${p.ref} (${Math.round(esc / pts.length * 100)}% of its estimated box touches or crosses a wall — check its real height / position)`);
        if (Date.now() > budget) { report.warnings.push('containment check stopped early (time limit)'); break; }
      }
      report.outside = out;
    }
    // manufacturability for the chosen process: thin walls, knife edges, narrow gaps, lid fit, openings
    if (opts.dfm !== false && opts.check !== false && Date.now() < budget) {
      const expected = [];
      if (pcb) for (const q of pcb.parts) {
        if (q.port) expected.push({ side: q.port.side, at: [q.port.x, q.port.y, q.port.z], what: `${q.ref} ${q.port.kind} port`, r: 9 });
        else if (q.plug && q.edge) expected.push({ side: q.edge, at: [q.cx, q.cy, q.side === 'top' ? pcb.thickness + q.h / 2 : -q.h / 2], what: `${q.ref} connector opening`, r: 9 });
        if (q.side === 'top' && (/led|switch|button|tact/i.test(q.type) || /\bled\b/i.test(String(q.value || '')))) expected.push({ side: 'top', at: [q.cx, q.cy, 0], what: `${q.ref} window`, r: 5 });
      }
      try {
        const fts = features.map(ft => { let box = null; try { box = MK ? mBounds(evalM(ft.node)) : bboxOf(evalNode(ft.node)); } catch (e) { } return Object.assign({}, ft, { node: undefined, box }); });
        const d = report.dfm = dfmCheck(parts, { process: opts.process, rules, features: fts, pcb, expected: expected.concat(intended), cap: opts.dfmCap || 8000, openPts: opts.dfmOpenPts || 2500, spacing: opts.dfmSpacing, timeMs: Math.min(8000, Math.max(1500, budget - Date.now() - 500)) }), R = d.rules, f = v => v.map(x => (+x).toFixed(1)).join(', ');
        if (d.thin.length) report.warnings.push(`${R.name}: ${d.thin.length} area${d.thin.length > 1 ? 's' : ''} thinner than ${R.wall} mm — thinnest ${d.thin[0].min_mm} mm in "${d.thin[0].part}" at (${f(d.thin[0].at)})${d.thin[0].feature ? ` under ${d.thin[0].feature}: ${d.thin[0].fix}` : ''}`);
        for (const x of d.too_small) report.warnings.push(`part "${x.part}" is ${x.size_mm.join(' × ')} mm — smaller than the ${R.name} minimum ${x.min_mm.join(' × ')} mm (JLC3DP refuses it): make it at least ${x.min_mm[0]} mm thick, or print it in SLA`);
        if ((d.edge_lips || []).length) report.warnings.push(`${d.edge_lips.length} edge lip${d.edge_lips.length > 1 ? 's' : ''} (thin strips along an open edge — print services flag them as thin walls) — thinnest ${d.edge_lips[0].min_mm} mm, ${d.edge_lips[0].area_mm2} mm² in "${d.edge_lips[0].part}" at (${d.edge_lips[0].at.join(', ')}): round or thicken that edge`);
        if (d.knife_edges.length) report.warnings.push(`${d.knife_edges.length} knife edge${d.knife_edges.length > 1 ? 's' : ''} (faces meeting below 30°, they break or fail to print) — first in "${d.knife_edges[0].part}" at (${f(d.knife_edges[0].at)})`);
        if (d.narrow_gaps.length) report.warnings.push(`${d.narrow_gaps.length} slit${d.narrow_gaps.length > 1 ? 's' : ''} narrower than ${R.gap} mm inside one part (they fuse shut) — first at (${f(d.narrow_gaps[0].at)})`);
        for (const x of d.fit.filter(x => !x.ok)) report.warnings.push(`${x.parts}: clearance ${x.clearance_mm} mm at (${f(x.at)}) is below the ${R.fit} mm ${R.name} needs — the parts may not fit together`);
        const un = d.openings.filter(x => !x.expected);
        if (un.length) report.warnings.push(`${un.length} opening${un.length > 1 ? 's' : ''} in the case that no connector / window explains: ${un.slice(0, 4).map(x => `${x.side} at (${f(x.at)}) ~${f(x.size_mm)} mm`).join('; ')} — a wall cut through? (ignore if intended)`);
      } catch (e) { report.warnings.push('manufacturability check failed: ' + e.message); }
    }
    budget = null; K().guard.deadline = 0; HQ3 = false; K().setQuality('preview');
    // outputs
    const { V } = K();
    const out = parts.map(p => {
      const b = bboxOf(p.polys), tris = K().triangles(p.polys);
      let open = 0, pieces = 1;
      let loose = null;
      if (p.m) {
        const all = p.m.decompose(), d = all.filter(x => x.volume() > 0), voids = all.filter(x => x.volume() < 0); pieces = d.length;
        if (voids.length && p.kind === 'print') report.warnings.push(`part "${p.name}" has ${voids.length} sealed hollow${voids.length > 1 ? 's' : ''} inside (${voids.map(x => (-x.volume()).toFixed(0) + ' mm³').join(', ')}) — powder / resin stays trapped in it: open it or add a ≥ 2 mm drain hole`);
        if (d.length > 1) { const big = d.reduce((a, x) => x.volume() > a.volume() ? x : a); loose = d.filter(x => x !== big).map(x => { const b = mBounds(x); return { at: [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2].map(v => +v.toFixed(2)), size: [b[3] - b[0], b[4] - b[1], b[5] - b[2]].map(v => +v.toFixed(2)), volume_mm3: +x.volume().toFixed(1) }; }); }
        for (const x of all) x.delete();
        if (p.dropped) report.warnings.push(`part "${p.name}": ${p.dropped} sliver${p.dropped > 1 ? 's' : ''} under 1 mm³ removed`); }   // Manifold output is watertight by construction
      else {
        const edges = new Map(), q = v => `${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;
        for (const [a, bb, c] of tris) for (const [u, w] of [[a, bb], [bb, c], [c, a]]) { const ku = q(u), kw = q(w); if (ku === kw) continue; const k = ku < kw ? ku + '|' + kw : kw + '|' + ku; edges.set(k, (edges.get(k) || 0) + 1); }
        for (const n of edges.values()) if (n % 2) open++;
        // separate solid pieces (polygons sharing a vertex belong together): a printed part should be one piece
        const par = new Map(), find = k => { while (par.get(k) !== k) { par.set(k, par.get(par.get(k))); k = par.get(k); } return k; };
        for (const pl of p.polys) { const ks = pl.v.map(q); for (const k of ks) if (!par.has(k)) par.set(k, k); const r0 = find(ks[0]); for (const k of ks) { const r1 = find(k); if (r1 !== r0) par.set(r1, r0); } }
        pieces = new Set([...par.keys()].map(find)).size;   // odd = a real hole; 4 = closed (non-manifold) seam
      }
      // print orientation: rotate, then sit on the bed (z min = 0), centred on x/y
      let tf = null;
      if (p.print && p.print.rotate) {
        const M = matrixOf({ op: 'rotate', v: vec3(p.print.rotate, 'print.rotate') });
        const rot = v => new V(M[0][0] * v.x + M[0][1] * v.y + M[0][2] * v.z, M[1][0] * v.x + M[1][1] * v.y + M[1][2] * v.z, M[2][0] * v.x + M[2][1] * v.y + M[2][2] * v.z);
        let zmin = Infinity; for (const pl of p.polys) for (const v of pl.v) zmin = Math.min(zmin, rot(v).z);
        tf = v => { const r = rot(v); return new V(r.x, r.y, r.z - zmin); };
      } else tf = v => new V(v.x, v.y, v.z - b[2]);
      const r = { name: p.name, kind: p.kind, loose, design: p.design || undefined, color: p.color || null, explode: p.explode, bbox: b.map(v => +v.toFixed(2)), size_mm: [b[3] - b[0], b[4] - b[1], b[5] - b[2]].map(v => +v.toFixed(2)), volume_cm3: +(volumeOf(p.polys) / 1000).toFixed(2), triangles: tris.length, open_edges: open, pieces };
      if (opts.keepPolys) r.polys = p.polys;
      if (p.thick && opts.mesh !== false) { r.thick = p.thick; r.samples = p.samples; }   // wall thickness (the viewer's heatmap)
      if (p.adhesive && p.flat) { r.flat = p.flat; r.adhesive = true; if (opts.step) { r.dxf = dxfOf(p.flat); r.pdf = pdfOfFlat(p.name, p.flat, 'Adhesive (e.g. 3M 2476P): cut along the line.'); } }
      if (p.kind === 'metal') { const fl = flatOf(p); if (p.hole !== undefined) { r.hole = p.hole; r.face = p.face; } if (fl) { r.flat = fl; r.sheet_mm = p.sheet || null; if (opts.step) { r.dxf = dxfOf(fl); r.step = stepOfSheet(p.name, fl, p.sheet || 0.5); } } }
      else if (opts.step) r.step = stepOfPolys(p.name, p.polys);
      if (opts.mesh !== false) Object.assign(r, K().meshArrays(p.polys));
      if (opts.stl !== false) r.stl = K().stl(p.polys, p.name, tf);
      return r;
    });
    const sheets = out.filter(p => p.flat && p.kind === 'metal');   // the panel is for the metal parts (not the adhesive)
    for (const p of sheets) { p.check = sheetCheck(p.flat, p.sheet_mm || 0.5); if (p.check.issues.length) report.warnings.push(`sheet part "${p.name}": ${p.check.issues.join('; ')}`); }
    if (opts.step && sheets.length > 1) { try {
      const t = sheets[0].sheet_mm || 0.5, J = joinedSheet(sheets.map(p => p.flat), t), fl = { loops: J.loops, open: J.open };
      report.joined = Object.assign(J, { dxf: dxfOfProfiles(J.loops, J.open), step: stepOfProfiles('plates-joined', J.loops.concat(J.open.map(c => slotLoop(c, 0.2))), t), pdf: pdfOfFlat('plates-joined (snip guide)', fl, `${t} mm stainless; snip at the red dashes.`, J.snips), check: sheetCheck(fl, t) });
      delete report.joined.chords;
    } catch (e) { report.warnings.push('joined sheet part: ' + e.message); } }
    // skin electrodes closer than ~5 mm get bridged by sweat
    for (let i = 0; i < electrodes.length; i++) for (let j = i + 1; j < electrodes.length; j++) {
      const A = electrodes[i], B = electrodes[j];
      // only plates on the same face (a lid plate over the skin plates is not bridged by sweat); minGap: 0 turns it off
      if (A.face !== B.face || !A.min || !B.min || Math.abs(A.z - B.z) > 6) continue;
      const d = polyGap(A.pts, B.pts), lim = Math.max(A.min, B.min);
      if (d < lim) report.warnings.push(`electrodes ${A.name} and ${B.name} are ${d.toFixed(1)} mm apart — sweat bridges gaps under about ${lim} mm (move them apart)`);
    }
    report.floating = out.filter(p => p.pieces > 1 && p.kind === 'print').map(p => ({ part: p.name, pieces: p.pieces, loose: p.loose }));
    for (const f of report.floating) report.warnings.push(`part "${f.part}" is ${f.pieces} separate pieces — ${f.loose ? f.loose.slice(0, 3).map(l => `loose piece at (${l.at.join(', ')}), ${l.size.join(' × ')} mm`).join('; ') + '. ' : ''}A solid that only touches the body face to face prints loose: make it overlap by ≥ 0.2 mm, or union it`);
    if (out.some(p => p.open_edges && p.kind === 'print')) report.warnings.push('some parts are not perfectly watertight (open_edges > 0) — most slicers repair this automatically');
    const scad = ['// CircuitPilot custom enclosure — OpenSCAD source generated from the 3D script (mm).', '// Coordinates: origin = PCB outline centre, Z = 0 at the PCB bottom.', '// Render one part: put ! in front of its call at the bottom, F6, then export STL.', '']
      .concat(parts.map(p => `module ${p.name.replace(/[^\w]/g, '_')}() {\n${scadOf(p.shape.node, '  ')}\n}\n`))
      .concat(parts.map(p => `${p.color ? `color("${p.color}") ` : ''}${p.explode ? `translate(${fv(p.explode)}) ` : ''}${p.name.replace(/[^\w]/g, '_')}();`)).join('\n') + '\n';
    return { parts: out, scad, logs, report, extras: extras.map(x => Object.assign({}, x)), kernel: MK ? 'manifold' : 'bsp', ms: Date.now() - t0 };
  }
  return { DESIGN, DENSITY, joinedSheet, sheetCheck, electrodePcb, assemblyGuide, dxfOfProfiles, stepOfProfiles, pdfOfFlat, dfmCheck, checkBox, PROCESSES, exportPack, stepOfPolys, stepOfSheet, dxfOf, profiles: P, run, context, useManifold, get fast() { return !!MF; }, HELP, EXAMPLES, TEMPLATES, PARAMS, fromTemplate, recipe, Shape, Shape2D };
})();
if (typeof module !== 'undefined') module.exports = Shape3D;
