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
  const is2 = s => s instanceof Shape2D;
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
    get polys() { return evalNode(this.node); }
    translate(v) { return new Shape({ op: 'translate', v: vec3(v, 'translate'), c: [this.node] }); }
    rotate(a, axis) {
      if (axis) return new Shape({ op: 'rotate', a: num(a, 'angle'), axis: vec3(axis, 'axis'), c: [this.node] });
      return new Shape({ op: 'rotate', v: typeof a === 'number' ? [0, 0, a] : vec3(a, 'rotate'), c: [this.node] });
    }
    scale(v) { return new Shape({ op: 'scale', v: vec3(v, 'scale', 1), c: [this.node] }); }
    mirror(v) { return new Shape({ op: 'mirror', v: vec3(v, 'mirror'), c: [this.node] }); }
    color(c) { return new Shape({ op: 'color', col: String(c), c: [this.node] }); }
    union(...o) { return union(this, ...o); }
    subtract(...o) { return difference(this, ...o); }
    difference(...o) { return difference(this, ...o); }
    intersect(...o) { return intersection(this, ...o); }
    get bounds() { const b = bboxOf(this.polys); return { min: b.slice(0, 3), max: b.slice(3), size: [b[3] - b[0], b[4] - b[1], b[5] - b[2]] }; }
  }
  const need3 = (s, fn) => { if (s instanceof Shape) return s.node; if (is2(s)) throw new Error(`${fn}(): got a 2D shape — extrude() or revolve() it first`); throw new Error(`${fn}(): expected a 3D shape, got ${s === undefined ? 'undefined' : typeof s}`); };
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
      default: P = transform(evalNode(n.c[0]), matrixOf(n));
    }
    n._p = P;
    return P;
  }
  function tick() { if (budget && Date.now() > budget) throw new Error('Model too complex: took longer than the time limit. Use fewer segments (fn), fewer/lower-resolution spheres in hulls, or fewer boolean operations.'); }

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

  // ---------- running a script ----------
  const HELP = `3D SCRIPT API (JavaScript; units mm; Z up). Build shapes, then register printable parts with part(name, shape, options).
COORDINATES: origin = centre of the PCB outline, X right, Y up (board "top" edge = +Y), Z = 0 at the PCB bottom face; PCB top at z = pcb.thickness.
CONTEXT: pcb = {w, h, thickness, shape:'round'|'ellipse'|'rect'|'rounded'|'polygon', radius (min(w,h)/2), center:[0,0], outline:[[x,y],…], holes:[{x,y,d}], parts:[{ref,type,value,x0,y0,x1,y1,cx,cy,h,side:'top'|'bottom',edge:'left'|'right'|'front'|'back'|null,plug, pads:[{num,net,x,y,w,h,shape,drill}]}]} or null when there is no PCB. part("E1") → that part; pad("E1.1") → that pad (electrode plates, contacts). Use these instead of numbers so the enclosure follows a board resize or a moved part.
  Component boxes: x0..x1, y0..y1; top parts span z = pcb.thickness … pcb.thickness + h, bottom parts z = -h … 0. edge = board edge a connector opens to (front = -Y, back = +Y).
2D: square([w,h],{center}), rect(w,h) (centred), circle(r|{d,fn}), ellipse(rx,ry), roundedRect(w,h,r) (centred), polygon([[x,y],…]), hull2d(...shapes), pcbOutline(offset=0)
    2D methods: .translate([x,y]) .rotate(deg) .scale(s|[sx,sy]) .mirror([x,y]) .offset(r) (outward > 0) .bounds .area .extrude(h,{center,scale}) .revolve({angle,fn})
3D: cube([x,y,z],{center}), roundedBox([x,y,z], r, {center:true}) (all edges rounded — great for pods), cylinder({h, r|d, r1, r2, center, fn}),
    sphere(r|{r|d, fn}), torus({R, r}), extrude(shape2d, h, {center, scale}) (linear extrude, scale tapers the top),
    revolve(shape2d, {angle=360, fn}) (profile in X=radius / Y=height plane swept around Z — bands, rings, domes, curved straps),
    hull(...shapes) (convex hull — smooth organic pods from spheres/cylinders), union(...), difference(a, ...b), intersection(...)
    methods: .translate([x,y,z]) .rotate([ax,ay,az]) (degrees, X then Y then Z) or .rotate(deg, [axis]) .scale(s|[x,y,z]) .mirror([x,y,z]) .color('name') .union() .subtract() .intersect() .bounds {min,max,size}
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
    Pattern: shell = difference(union(softSolid(out, zLow, zTop+t), extras), cavity(e), cuts, connectorCuts(e), topWindows(e, zt)); shell = union(shell, boardPosts(e)); [base, lid] = splitLid(shell, e, e.zTop).
    TEMPLATES: 35 ready scripts (10 wrist, 10 chest / ECG, 7 other body-worn, 8 boxes) — get them with enclosure_script_help({template: id}) and adapt.
OUTPUT: part(name, shape, {color, explode:[x,y,z] (offset in the exploded preview), print:{rotate:[ax,ay,az]} (orientation for the STL, dropped onto the bed)}).
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
    L.push(`const t = ${o.wall ?? 1.8};              // wall thickness (mm)`);
    L.push(`const corner = ${o.r ?? 4};          // corner radius for rect`);
    L.push(`const roundTop = ${o.rTop ?? 2.5}, roundBottom = ${o.rBot ?? 1.2};   // edge rounding`);
    L.push(`const wrist = ${o.curve || 0};             // concave underside radius (0 = flat)`);
    L.push(`const minW = ${o.minW || 0}, minL = ${o.minL || 0};   // minimum outer size (e.g. electrode spacing)`);
    L.push(`const strapAxis = '${o.axis || 'y'}';         // direction the strap / body curve runs (x | y)`);
    if (o.lugs) L.push(`const strap = ${o.strap || 22}, lugStyle = '${o.lugs}';   // strap width, slot | pins | bar`);
    L.push(`const e = envelope({ gap: 0.5, headroom: ${o.headroom ?? 0.8} });`);
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
    if (o.flange) L.push(`adds.push(extrude(out.offset(${o.flange}), 1.5).translate([0, 0, zLow - 0.3]));   // adhesive flange (0.3 below the body: no coplanar faces)`);
    if (o.lugs) L.push(`{ const g = strapLugs({ W: strapAxis === 'x' ? BL : BW, L: strapAxis === 'x' ? BW : BL, z: zLow + ${o.lugs === 'pins' ? '3' : '2.4'}, strap, style: lugStyle, t: ${o.lugT || 4.5}, cx: 0, cy: 0, outline: strapAxis === 'x' ? out.translate([-e.cx, -e.cy]).rotate(-90) : out.translate([-e.cx, -e.cy]) });`,
      `  const place = s => strapAxis === 'x' ? s.rotate([0, 0, 90]).translate([e.cx, e.cy, 0]) : s.translate([e.cx, e.cy, 0]); adds.push(place(g.add)); cuts.push(place(g.cut)); }`);
    if (o.electrodes) {
      L.push(`// snap-electrode studs (Ø3.9–4 mm studs → Ø4.2 holes) on the ${o.studsTop ? 'top (lead wires snap on)' : 'skin side'}`);
      const lay = { '3lead': `[[B[0] + 9, e.cy], [B[2] - 9, e.cy], [e.cx, B[1] + 8]]`, '2bar': `[[B[0] + 9, e.cy], [B[2] - 9, e.cy]]`, '5lead': `[[B[0] + 9, B[1] + 9], [B[2] - 9, B[1] + 9], [B[0] + 9, B[3] - 9], [B[2] - 9, B[3] - 9], [e.cx, B[1] + 8]]`, '4square': `[[B[0] + 9, B[1] + 9], [B[2] - 9, B[1] + 9], [B[0] + 9, B[3] - 9], [B[2] - 9, B[3] - 9]]`, 'tri': `[90, 210, 330].map(a => [e.cx + (Math.min(BW, BL) / 2 - 9) * Math.cos(a * PI / 180), e.cy + (Math.min(BW, BL) / 2 - 9) * Math.sin(a * PI / 180)])` }[o.electrodes];
      L.push(`const studs = ${lay};`);
      if (o.studsTop) L.push(`for (const [x, y] of studs) { adds.push(cylinder({ d: 9, h: 1.5 }).translate([x, y, zt - 0.01])); cuts.push(cylinder({ d: 4.2, h: t + 2 }).translate([x, y, zt - t - 0.5])); }`);
      else L.push(`for (const [x, y] of studs) { adds.push(cylinder({ d: 9, h: 1.5 }).translate([x, y, zLow - 1.5])); cuts.push(cylinder({ d: 4.2, h: e.zFloor - zLow + 2.5 }).translate([x, y, zLow - 2])); }`);
    }
    if (o.clip) L.push(`adds.push(beltClip(BW, BL, zLow, e.cx, e.cy));   // spring clip on the back`);
    if (o.loop) L.push(`adds.push(loop(BL, (zLow + zt) / 2, e.cx, e.cy, ${o.loopR || 4}, ${o.loopr || 1.6}));   // lanyard / key-ring loop`);
    if (o.ears) L.push(`{ const m = mountEars(BW, zLow, e.cx, e.cy); adds.push(m.add); cuts.push(m.cut); }   // screw ears`);
    if (o.vents) L.push(`cuts.push(ventSlots(e, zt, ${o.vents}));`);
    L.push(`const inner = out.offset(-t);                    // hollow inside, following the outer shape`);
    L.push(`let shell = difference(union(body, ...adds), hollow(out, e, t, roundTop), ...cuts, cutter, connectorCuts(e), topWindows(e, zt));`);
    L.push(`shell = union(shell, boardPosts(e));`);
    L.push(`const [base, lid] = splitLid(shell, e, e.zTop, { fit: 0.2, lipH: ${o.lipH ?? 1.6}, inner });`);
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
      let edge = null;
      if (p.edge) { const d = [['left', x0 + w / 2], ['right', w / 2 - x1], ['front', y0 + h / 2], ['back', h / 2 - y1]].sort((a, b) => a[1] - b[1]); edge = d[0][0]; }
      // pads in script coordinates too (electrode plates, test pads, contacts): no more hard-coded positions
      let pads = [];
      try { if (p.c && typeof Pcb !== 'undefined') pads = Pcb.padsOf(p.c, Model.pinIndex()).map(q => ({ num: q.num, net: q.net || null, x: r(q.x - ox), y: r(-q.y - oy), w: r(q.w), h: r(q.h), shape: q.shape || 'rect', drill: q.drill || 0 })); } catch (e) { pads = []; }
      return { ref: p.ref, type: p.type, value: p.value, x0: r(x0), y0: r(y0), x1: r(x1), y1: r(y1), cx: r((x0 + x1) / 2), cy: r((y0 + y1) / 2), h: p.h, side: p.bottom ? 'bottom' : 'top', edge, plug: !!(p.edge && p.edge.plug), pads };
    });
    // board shape in words, and the radius of a round board (so scripts follow a resize)
    const sh = (typeof Model !== 'undefined' && Model.S.board.shape) || { type: 'rect' }, shape = sh.type === 'ellipse' ? (Math.abs(w - h) < 0.01 ? 'round' : 'ellipse') : sh.type === 'polygon' ? 'polygon' : sh.type === 'rounded' ? 'rounded' : 'rect';
    return { pcb: { w: r(w), h: r(h), thickness: L.P.pcbThickness, shape, radius: r(Math.min(w, h) / 2), center: [0, 0], outline: L.bpoly.map(q => [r(q[0] - ox), r(q[1] - oy)]), holes: L.holes.map(q => ({ x: r(q.x - ox), y: r(q.y - oy), d: q.d })), parts }, origin: [ox, oy, L.pcbZ] };
  }

  function run(code, ctx = {}, opts = {}) {
    const t0 = Date.now(), parts = [], logs = [];
    budget = t0 + (opts.timeLimitMs || 90000); K().guard.deadline = budget;
    HQ3 = opts.quality === 'high'; K().setQuality(HQ3 ? 'high' : 'preview');
    FN = 0;
    const pcb = ctx.pcb || null;
    const lib = {
      square: api2.square, rect: api2.rect, circle: api2.circle, ellipse: api2.ellipse, roundedRect: api2.roundedRect, polygon: api2.polygon, hull2d: api2.hull2d,
      cube, box: cube, roundedBox, cylinder, sphere, torus, extrude, linearExtrude: extrude, revolve, rotateExtrude: revolve, hull, union, difference, intersection,
      pcbOutline: (off = 0) => { if (!pcb) throw new Error('pcbOutline(): this project has no PCB yet'); const s = new Shape2D(pcb.outline); return off ? s.offset(off) : s; },
      board: (extra = 0) => { if (!pcb) throw new Error('board(): this project has no PCB yet'); return extrude(lib.pcbOutline(extra), pcb.thickness); },
      part: ref => { if (!pcb) throw new Error('part(): this project has no PCB yet'); const q = pcb.parts.find(x => x.ref === ref); if (!q) throw new Error(`part(): no part ${ref} on the board`); return q; },
      pad: key => { if (!pcb) throw new Error('pad(): this project has no PCB yet'); const i = String(key).lastIndexOf('.'), q = pcb.parts.find(x => x.ref === String(key).slice(0, i)), d = q && q.pads.find(x => String(x.num) === String(key).slice(i + 1)); if (!d) throw new Error(`pad(): no pad ${key} (use "REF.PIN")`); return d; },
      partBoxes: (o = {}) => {
        if (!pcb) throw new Error('partBoxes(): this project has no PCB yet');
        const c = o.clearance ?? 0.5, ps = pcb.parts.filter(p => !o.side || p.side === o.side);
        return union(ps.map(p => cube([p.x1 - p.x0 + 2 * c, p.y1 - p.y0 + 2 * c, p.h + c]).translate([p.x0 - c, p.y0 - c, p.side === 'top' ? pcb.thickness : -p.h - c])));
      },
      part: (name, shape, o = {}) => { need3(shape, 'part'); parts.push({ name: String(name || 'part' + (parts.length + 1)).replace(/[^\w.-]+/g, '_'), shape, color: o.color, explode: o.explode ? vec3(o.explode, 'explode') : null, print: o.print || null }); return shape; },
      resolution: n => { FN = Math.max(0, Math.min(256, Math.round(+n || 0))); },
      range: (a, b, s = 1) => { const out = []; for (let x = a; s > 0 ? x <= b + 1e-9 : x >= b - 1e-9; x += s) { out.push(+x.toFixed(9)); if (out.length > 10000) break; } return out; },
      log: (...a) => { logs.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')); },
      PI: Math.PI, pcb,
    };
    // ---------- enclosure kit: building blocks shared by the templates (and available to the AI) ----------
    const K2 = lib;
    // Space the board needs: PCB outline + every part box (connectors that open outward excepted), plus a gap.
    K2.envelope = (o = {}) => {
      const gap = o.gap ?? 0.5, head = o.headroom ?? 0.8, standoff = o.standoff ?? 1.2;
      if (!pcb) { const w = o.w ?? 32, l = o.l ?? 24; return { w, l, cx: 0, cy: 0, x0: -w / 2, y0: -l / 2, x1: w / 2, y1: l / 2, top: 6, under: 0, zFloor: -standoff, zTop: 6 + head, plugs: [], leds: [], buttons: [], gap }; }
      const xs = pcb.outline.map(q => q[0]), ys = pcb.outline.map(q => q[1]);
      let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      // side: 'top' / 'bottom' — only that side's parts; parts / exclude: by reference
      const only = o.parts ? new Set(o.parts) : null, skip = new Set(o.exclude || []);
      const use = pcb.parts.filter(p => (!o.side || o.side === 'both' || p.side === o.side) && (!only || only.has(p.ref)) && !skip.has(p.ref));
      for (const p of use) if (!(p.plug && p.edge)) { x0 = Math.min(x0, p.x0); x1 = Math.max(x1, p.x1); y0 = Math.min(y0, p.y0); y1 = Math.max(y1, p.y1); }
      x0 -= gap; y0 -= gap; x1 += gap; y1 += gap;
      const top = Math.max(pcb.thickness, ...use.filter(p => p.side === 'top').map(p => pcb.thickness + p.h));
      const under = Math.max(0, ...use.filter(p => p.side === 'bottom').map(p => p.h));
      return { w: x1 - x0, l: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, x0, y0, x1, y1, top, under, zFloor: -(under + standoff), zTop: top + head, gap,
        plugs: pcb.parts.filter(p => p.plug && p.edge), leds: pcb.parts.filter(p => p.side === 'top' && (/led/i.test(p.type) || /\bled\b/i.test(String(p.value || '')))),
        buttons: pcb.parts.filter(p => p.side === 'top' && /switch|button|tact/i.test(p.type)) };
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
    K2.softSolid = (out, z0, z1, rTop = 2, rBot = 1) => {
      const H = z1 - z0; rTop = Math.max(0, Math.min(rTop, H / 2 - 0.02)); rBot = Math.max(0, Math.min(rBot, H / 2 - 0.02));
      if (rTop < 0.05 && rBot < 0.05) return extrude(out, H).translate([0, 0, z0]);
      const ring = (inset, z) => ({ z, pts: (inset > 0.01 ? out.offset(-inset) : out).pts });
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
    K2.hollow = (out, e, t, roundTop = 0, r = 1) => union(K2.cavity(e, r), roundTop > t + 0.05 ? K2.softSolid(out.offset(-t), e.zFloor, e.zTop + 0.25, roundTop - t, 0) : extrude(out.offset(-t), e.zTop + 0.25 - e.zFloor).translate([0, 0, e.zFloor]));
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
        let post = cylinder({ d: pcb.holes.length ? Math.max(d, 4.5) : d, h: -e.zFloor + 0.01 }).translate([x, y, e.zFloor - 0.01]);
        if (pcb.holes.length) post = difference(post, cylinder({ d: 2.5, h: 20, center: true }).translate([x, y, e.zFloor]));
        list.push(post);
      }
      return list.length ? union(list) : null;
    };
    // openings for edge connectors (USB, jacks…) through the walls
    K2.connectorCuts = (e, m = 0.6) => {
      const cuts = [];
      for (const p of e.plugs) {
        const zc = p.side === 'top' ? pcb.thickness + p.h / 2 : -p.h / 2, hz = p.h + 2 * m;
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
      for (const p of e.leds) list.push(cylinder({ d: o.led ?? 2.6, h: zt - p.h + 20 }).translate([p.cx, p.cy, pcb.thickness + p.h - 0.2]));
      for (const p of e.buttons) list.push(cylinder({ d: o.button ?? Math.min(6, Math.max(3, Math.min(p.x1 - p.x0, p.y1 - p.y0) * 0.7)), h: zt + 20 }).translate([p.cx, p.cy, pcb.thickness + p.h - 0.2]));
      return list.length ? union(list) : null;
    };
    // split into base and lid at zSplit; the lid gets a press-fit lip that steers around tall parts
    K2.splitLid = (shell, e, zSplit, o = {}) => {
      const fit = o.fit ?? 0.2, lw = o.lipW ?? 1.2, lh = o.lipH ?? 1.6, b = shell.bounds, m = 1.37;   // cutting boxes just larger than the part (precision)
      const sx = b.size[0] + 2 * m, sy = b.size[1] + 2 * m;
      const below = intersection(shell, cube([sx, sy, zSplit - b.min[2] + m]).translate([b.min[0] - m, b.min[1] - m, b.min[2] - m]));
      let above = intersection(shell, cube([sx, sy, b.max[2] - zSplit + m]).translate([b.min[0] - m, b.min[1] - m, zSplit]));
      if (lh > 0 && e.w > 2 * (lw + fit) + 2 && e.l > 2 * (lw + fit) + 2) {
        // lip along the inside wall: o.inner (the hollow outline) when given, else the board pocket; corners rounder than
        // the pocket's so the two never run nearly tangent (clean booleans)
        const o1 = o.inner ? o.inner.offset(-fit) : api2.roundedRect(e.w - 2 * fit, e.l - 2 * fit, 2.2).translate([e.cx, e.cy]);
        const o2 = o.inner ? o.inner.offset(-fit - lw) : api2.roundedRect(e.w - 2 * fit - 2 * lw, e.l - 2 * fit - 2 * lw, 1.0).translate([e.cx, e.cy]);
        let lip = difference(extrude(o1, lh + 0.4).translate([0, 0, zSplit - lh]), extrude(o2, lh + 2).translate([0, 0, zSplit - lh - 1]));
        if (pcb) { const tall = pcb.parts.filter(p => p.side === 'top' && pcb.thickness + p.h > zSplit - lh - 0.3); if (tall.length) lip = difference(lip, ...tall.map(p => cube([p.x1 - p.x0 + 0.8, p.y1 - p.y0 + 0.8, 40]).translate([p.x0 - 0.4, p.y0 - 0.4, -10]))); }
        above = union(above, lip);
      }
      return [below, above];
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
      const { W, L, z, strap = 22, style = 'slot', t = 4.5, cx = 0, cy = 0, outline = null } = o, add = [], cut = [];
      const reach = (x, s) => { const e = outline ? K2.edgeAt(outline, x, s) : null; return e == null ? cy : e - s * 1.5; };   // 1.5 mm into the body
      for (const s of [-1, 1]) {
        const yE = cy + s * L / 2;
        if (style === 'pins') {
          for (const sx of [-1, 1]) {
            const x = cx + sx * (strap / 2 + 1.6), y0 = Math.min(s * reach(x - 1.6, s), s * reach(x + 1.6, s), s * (yE - s * 1)) * s, y1 = yE + s * 7;
            add.push(roundedBox([3.2, Math.abs(y1 - y0), t], 1.2).translate([x, (y0 + y1) / 2, z]));
          }
          cut.push(cylinder({ d: 1.3, h: strap + 12, center: true, fn: 16 }).rotate([0, 90, 0]).translate([cx, yE + s * 5, z]));
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
    K2.ventSlots = (e, zt, n = 5) => { const w = Math.min(e.w * 0.5, 30), list = []; for (let k = 0; k < n; k++) list.push(roundedBox([w, 1.4, 30], 0.6).translate([e.cx, e.cy - (n - 1) * 1.8 + k * 3.6, zt])); return union(list); };
    // mounting ears with screw holes on ±X
    K2.mountEars = (W, zb, cx = 0, cy = 0, th = 3) => { const add = [], cut = []; for (const s of [-1, 1]) { add.push(roundedBox([12, 14, th], 1.2).translate([cx + s * (W / 2 + 5), cy, zb + th / 2])); cut.push(cylinder({ d: 3.4, h: 20, center: true }).translate([cx + s * (W / 2 + 6), cy, zb])); } return { add: union(add), cut: union(cut) }; };
    const names = Object.keys(lib);
    let ret;
    try {
      // the script runs in its own inner scope, so its own variables may reuse kit names (cavity, loop, …)
      const fn = new Function(...names, 'console', '"use strict"; return (() => {\n' + code + '\n})();');
      ret = fn(...names.map(k => lib[k]), { log: lib.log, warn: lib.log, error: lib.log });
      if (!parts.length && ret instanceof Shape) lib.part('model', ret);
      if (!parts.length) throw new Error('The script made no parts — call part("name", shape) (or return a shape).');
      for (const p of parts) { p.polys = K().fillHoles(K().zipSeams(K().repair(p.shape.polys.map(q => q.clone())))); if (!p.polys.length) throw new Error(`part "${p.name}" is empty (check the boolean operations / positions)`); }
    } catch (e) {
      const m = String(e && e.stack || '').match(/eval at [^\n]*?<anonymous>:(\d+):(\d+)/) || String(e && e.stack || '').match(/^\s*at [^\n(]*\(?<anonymous>:(\d+):(\d+)/m);
      const err = new Error((e && e.message || String(e)) + (m ? ` (script line ${+m[1] - 3})` : ''));
      err.line = m ? +m[1] - 3 : null; err.logs = logs; budget = null; K().guard.deadline = 0; HQ3 = false; K().setQuality('preview'); throw err;
    }
    // fit report: shells must not cut into the board or the components
    const report = { collisions: [], warnings: [] };
    if (pcb && opts.check !== false) {
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
    budget = null; K().guard.deadline = 0; HQ3 = false; K().setQuality('preview');
    // outputs
    const { V } = K();
    const out = parts.map(p => {
      const b = bboxOf(p.polys), tris = K().triangles(p.polys);
      const edges = new Map(), q = v => `${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;
      for (const [a, bb, c] of tris) for (const [u, w] of [[a, bb], [bb, c], [c, a]]) { const ku = q(u), kw = q(w); if (ku === kw) continue; const k = ku < kw ? ku + '|' + kw : kw + '|' + ku; edges.set(k, (edges.get(k) || 0) + 1); }
      let open = 0; for (const n of edges.values()) if (n % 2) open++;
      // separate solid pieces (polygons sharing a vertex belong together): a printed part should be one piece
      const par = new Map(), find = k => { while (par.get(k) !== k) { par.set(k, par.get(par.get(k))); k = par.get(k); } return k; };
      for (const pl of p.polys) { const ks = pl.v.map(q); for (const k of ks) if (!par.has(k)) par.set(k, k); const r0 = find(ks[0]); for (const k of ks) { const r1 = find(k); if (r1 !== r0) par.set(r1, r0); } }
      const pieces = new Set([...par.keys()].map(find)).size;   // odd = a real hole; 4 = closed (non-manifold) seam
      // print orientation: rotate, then sit on the bed (z min = 0), centred on x/y
      let tf = null;
      if (p.print && p.print.rotate) {
        const M = matrixOf({ op: 'rotate', v: vec3(p.print.rotate, 'print.rotate') });
        const rot = v => new V(M[0][0] * v.x + M[0][1] * v.y + M[0][2] * v.z, M[1][0] * v.x + M[1][1] * v.y + M[1][2] * v.z, M[2][0] * v.x + M[2][1] * v.y + M[2][2] * v.z);
        let zmin = Infinity; for (const pl of p.polys) for (const v of pl.v) zmin = Math.min(zmin, rot(v).z);
        tf = v => { const r = rot(v); return new V(r.x, r.y, r.z - zmin); };
      } else tf = v => new V(v.x, v.y, v.z - b[2]);
      const r = { name: p.name, color: p.color || null, explode: p.explode, bbox: b.map(v => +v.toFixed(2)), size_mm: [b[3] - b[0], b[4] - b[1], b[5] - b[2]].map(v => +v.toFixed(2)), volume_cm3: +(volumeOf(p.polys) / 1000).toFixed(2), triangles: tris.length, open_edges: open, pieces };
      if (opts.keepPolys) r.polys = p.polys;
      if (opts.mesh !== false) Object.assign(r, K().meshArrays(p.polys));
      if (opts.stl !== false) r.stl = K().stl(p.polys, p.name, tf);
      return r;
    });
    report.floating = out.filter(p => p.pieces > 1).map(p => ({ part: p.name, pieces: p.pieces }));
    for (const f of report.floating) report.warnings.push(`part "${f.part}" is ${f.pieces} separate pieces — a feature does not touch the body (move it so it overlaps, or union it)`);
    if (out.some(p => p.open_edges)) report.warnings.push('some parts are not perfectly watertight (open_edges > 0) — most slicers repair this automatically');
    const scad = ['// CircuitPilot custom enclosure — OpenSCAD source generated from the 3D script (mm).', '// Coordinates: origin = PCB outline centre, Z = 0 at the PCB bottom.', '// Render one part: put ! in front of its call at the bottom, F6, then export STL.', '']
      .concat(parts.map(p => `module ${p.name.replace(/[^\w]/g, '_')}() {\n${scadOf(p.shape.node, '  ')}\n}\n`))
      .concat(parts.map(p => `${p.color ? `color("${p.color}") ` : ''}${p.explode ? `translate(${fv(p.explode)}) ` : ''}${p.name.replace(/[^\w]/g, '_')}();`)).join('\n') + '\n';
    return { parts: out, scad, logs, report, ms: Date.now() - t0 };
  }
  return { run, context, HELP, EXAMPLES, TEMPLATES, Shape, Shape2D };
})();
if (typeof module !== 'undefined') module.exports = Shape3D;
