'use strict';
// Parametric 3D-printable enclosure fitted to the PCB: CSG geometry (BSP, after csg.js by Evan Wallace, MIT),
// STL export and an equivalent OpenSCAD source. No DOM — also runs in Node (MCP server).
const Enclosure = (() => {
  // ---------------- CSG (BSP trees) ----------------
  const EPS = 1e-5;
  class V {
    constructor(x, y, z) { this.x = x; this.y = y; this.z = z; }
    plus(a) { return new V(this.x + a.x, this.y + a.y, this.z + a.z); }
    minus(a) { return new V(this.x - a.x, this.y - a.y, this.z - a.z); }
    times(k) { return new V(this.x * k, this.y * k, this.z * k); }
    dot(a) { return this.x * a.x + this.y * a.y + this.z * a.z; }
    cross(a) { return new V(this.y * a.z - this.z * a.y, this.z * a.x - this.x * a.z, this.x * a.y - this.y * a.x); }
    len() { return Math.sqrt(this.dot(this)); }
    unit() { return this.times(1 / this.len()); }
    lerp(a, t) { return this.plus(a.minus(this).times(t)); }
    neg() { return new V(-this.x, -this.y, -this.z); }
  }
  class Plane {
    constructor(n, w) { this.n = n; this.w = w; }
    static from(a, b, c) { const n = b.minus(a).cross(c.minus(a)); const l = n.len(); if (l < 1e-12) return null; const u = n.times(1 / l); return new Plane(u, u.dot(a)); }
    clone() { return new Plane(this.n, this.w); }
    flip() { this.n = this.n.neg(); this.w = -this.w; }
    split(poly, cf, cb, f, b) {
      let pt = 0; const types = [];
      for (const v of poly.v) { const t = this.n.dot(v) - this.w, ty = t < -EPS ? 2 : t > EPS ? 1 : 0; pt |= ty; types.push(ty); }
      if (pt === 0) (this.n.dot(poly.plane.n) > 0 ? cf : cb).push(poly);
      else if (pt === 1) f.push(poly);
      else if (pt === 2) b.push(poly);
      else {
        const F = [], B = [], n = poly.v.length;
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n, ti = types[i], tj = types[j], vi = poly.v[i], vj = poly.v[j];
          if (ti !== 2) F.push(vi); if (ti !== 1) B.push(vi);
          if ((ti | tj) === 3) { const t = (this.w - this.n.dot(vi)) / this.n.dot(vj.minus(vi)), v = vi.lerp(vj, t); F.push(v); B.push(v); }
        }
        // fragments keep the parent plane (recomputing it drops slivers and leaves holes)
        if (F.length >= 3) f.push(new Poly(F, poly.plane.clone()));
        if (B.length >= 3) b.push(new Poly(B, poly.plane.clone()));
      }
    }
  }
  class Poly {
    constructor(v, plane) { this.v = v; this.plane = plane; }
    static make(v) { const pl = Plane.from(v[0], v[1], v[2]) || (v.length > 3 && Plane.from(v[0], v[2], v[3])); return pl ? new Poly(v, pl) : null; }
    flip() { this.v = this.v.slice().reverse(); this.plane = new Plane(this.plane.n.neg(), -this.plane.w); return this; }
    clone() { return new Poly(this.v.slice(), this.plane.clone()); }
  }
  class Node {
    constructor(polys) { this.plane = null; this.front = null; this.back = null; this.polys = []; if (polys) this.build(polys); }
    // all tree walks are iterative: curved models make deep trees that would overflow the call stack
    nodes() { const out = [], st = [this]; while (st.length) { const n = st.pop(); out.push(n); if (n.front) st.push(n.front); if (n.back) st.push(n.back); } return out; }
    invert() { for (const n of this.nodes()) { for (const p of n.polys) p.flip(); if (n.plane) n.plane.flip(); const t = n.front; n.front = n.back; n.back = t; } }
    clip(polys) {
      const out = [], st = [[this, polys]];
      while (st.length) {
        const [n, ps] = st.pop();
        if (!n.plane) { for (const p of ps) out.push(p); continue; }
        const f = [], b = [];
        check();
        for (const p of ps) n.plane.split(p, f, b, f, b);
        if (f.length) { if (n.front) st.push([n.front, f]); else for (const p of f) out.push(p); }
        if (b.length && n.back) st.push([n.back, b]);
      }
      return out;
    }
    clipTo(bsp) { for (const n of this.nodes()) n.polys = bsp.clip(n.polys); }
    all() { const out = []; for (const n of this.nodes()) for (const p of n.polys) out.push(p); return out; }
    build(polys) {
      const st = [[this, polys]];
      while (st.length) {
        const [n, ps] = st.pop();
        if (!ps.length) continue;
        if (!n.plane) n.plane = ps[0].plane.clone();
        const f = [], b = [];
        check();
        for (const p of ps) n.plane.split(p, n.polys, n.polys, f, b);
        if (guard.maxPolys && n.polys.length + f.length + b.length > guard.maxPolys) throw new Error('Model too complex: the boolean operations produced too many polygons. Use fewer segments (resolution / fn) or simpler shapes.');
        if (f.length) { if (!n.front) n.front = new Node(); st.push([n.front, f]); }
        if (b.length) { if (!n.back) n.back = new Node(); st.push([n.back, b]); }
      }
    }
  }
  // guard for runaway booleans: a deadline (ms epoch) and a polygon budget, checked inside the BSP loops
  const guard = { deadline: 0, maxPolys: 0, n: 0 };
  const check = () => { if ((++guard.n & 1023) === 0 && guard.deadline && Date.now() > guard.deadline) throw new Error('Model too complex: the boolean operations took too long. Use fewer segments (resolution / fn) or simpler shapes.'); };
  const cl = ps => ps.map(p => p.clone());
  function union(A, B) { if (!A.length) return cl(B); if (!B.length) return cl(A); const a = new Node(cl(A)), b = new Node(cl(B)); a.clipTo(b); b.clipTo(a); b.invert(); b.clipTo(a); b.invert(); a.build(b.all()); return a.all(); }
  function subtract(A, B) { if (!B.length) return cl(A); const a = new Node(cl(A)), b = new Node(cl(B)); a.invert(); a.clipTo(b); b.clipTo(a); b.invert(); b.clipTo(a); b.invert(); a.build(b.all()); a.invert(); return a.all(); }
  function intersect(A, B) { if (!A.length || !B.length) return []; const a = new Node(cl(A)), b = new Node(cl(B)); a.invert(); b.clipTo(a); b.invert(); a.clipTo(b); b.clipTo(a); a.build(b.all()); a.invert(); return a.all(); }

  // ---------------- 2D helpers ----------------
  const area = P => { let a = 0; for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
  const ccw = P => area(P) < 0 ? P.slice().reverse() : P.slice();
  function dedupe(P) { const out = []; for (const p of P) { const q = out[out.length - 1]; if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-4) out.push(p); } if (out.length > 2 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 1e-4) out.pop(); return out; }
  // offset a CCW polygon by d (outward > 0) with round joins on convex corners
  const isConvex = P => P.every((B, i) => { const A = P[(i - 1 + P.length) % P.length], C = P[(i + 1) % P.length]; return (B[0] - A[0]) * (C[1] - B[1]) - (B[1] - A[1]) * (C[0] - B[0]) >= -1e-9; });
  // shrink a convex CCW polygon exactly: clip it by every edge moved inward (Sutherland–Hodgman)
  function shrinkConvex(P, d) {
    let out = P.slice();
    for (let i = 0; i < P.length && out.length; i++) {
      const a = P[i], b = P[(i + 1) % P.length], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy); if (l < 1e-9) continue;
      const nx = -dy / l, ny = dx / l, c = nx * a[0] + ny * a[1] + d;          // inward normal (left of a CCW edge)
      const side = q => nx * q[0] + ny * q[1] - c, res = [];
      for (let k = 0; k < out.length; k++) {
        const p = out[k], q = out[(k + 1) % out.length], sp = side(p), sq = side(q);
        if (sp >= 0) res.push(p);
        if ((sp >= 0) !== (sq >= 0)) { const t = sp / (sp - sq); res.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
      }
      out = res;
    }
    return dedupe(out);
  }
  function offset(P, d) {
    P = ccw(dedupe(P)); if (Math.abs(d) < 1e-9) return P;
    if (d < 0 && isConvex(P)) return shrinkConvex(P, -d);
    const n = P.length, out = [];
    const nrm = (a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [dy / l, -dx / l]; };
    for (let i = 0; i < n; i++) {
      const A = P[(i - 1 + n) % n], B = P[i], C = P[(i + 1) % n], n1 = nrm(A, B), n2 = nrm(B, C);
      const cr = (B[0] - A[0]) * (C[1] - B[1]) - (B[1] - A[1]) * (C[0] - B[0]); // > 0: convex (CCW)
      if ((cr > 1e-9) === (d > 0)) {
        // arc around the corner
        let a1 = Math.atan2(n1[1], n1[0]), a2 = Math.atan2(n2[1], n2[0]);
        if (d > 0) { while (a2 < a1) a2 += 2 * Math.PI; } else { while (a2 > a1) a2 -= 2 * Math.PI; }
        const steps = Math.max(1, Math.ceil(Math.abs(a2 - a1) / (HQ ? Math.PI / 64 : Math.PI / 16)));
        for (let k = 0; k <= steps; k++) { const a = a1 + (a2 - a1) * k / steps; out.push([B[0] + Math.cos(a) * Math.abs(d) * Math.sign(d), B[1] + Math.sin(a) * Math.abs(d) * Math.sign(d)]); }
      } else {
        // mitre (limited)
        const bx = n1[0] + n2[0], by = n1[1] + n2[1], bl = Math.hypot(bx, by) || 1, cosh = (n1[0] * n2[0] + n1[1] * n2[1] + 1) / 2;
        const m = d / Math.sqrt(Math.max(cosh, 0.15));
        out.push([B[0] + bx / bl * m, B[1] + by / bl * m]);
      }
    }
    return dedupe(out);
  }
  // quality: 'preview' (fast) or 'high' (fine segments for the STLs sent to a print service)
  let HQ = false;
  const setQuality = q => { HQ = q === 'high'; };
  const circle = (cx, cy, r, n = 28) => { if (HQ) n = Math.max(n, Math.min(160, Math.ceil(2 * Math.PI * r / 0.35)), 48); return Array.from({ length: n }, (_, k) => [cx + r * Math.cos(k / n * 2 * Math.PI), cy + r * Math.sin(k / n * 2 * Math.PI)]); };
  const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  function earcut(P) { // ear clipping for a simple CCW polygon → triangles (index triples)
    const idx = P.map((_, i) => i), tris = [];
    const crs = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const inside = (p, a, b, c) => crs(a, b, p) >= -1e-12 && crs(b, c, p) >= -1e-12 && crs(c, a, p) >= -1e-12;
    let guard = 0;
    while (idx.length > 3 && guard++ < 10000) {
      let cut = false;
      for (let i = 0; i < idx.length; i++) {
        const ia = idx[(i - 1 + idx.length) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length], a = P[ia], b = P[ib], c = P[ic];
        if (crs(a, b, c) <= 1e-12) continue;
        if (idx.some(j => j !== ia && j !== ib && j !== ic && inside(P[j], a, b, c))) continue;
        tris.push([ia, ib, ic]); idx.splice(i, 1); cut = true; break;
      }
      if (!cut) break;
    }
    if (idx.length === 3) tris.push(idx.slice());
    return tris;
  }
  // prism: extrude a 2D polygon between z0 and z1
  function prism(P2, z0, z1) {
    const P = ccw(dedupe(P2)), out = [], n = P.length;
    for (let i = 0; i < n; i++) {
      const a = P[i], b = P[(i + 1) % n];
      const q = Poly.make([new V(a[0], a[1], z0), new V(b[0], b[1], z0), new V(b[0], b[1], z1), new V(a[0], a[1], z1)]); if (q) out.push(q);
    }
    for (const [i, j, k] of earcut(P)) {
      const top = Poly.make([new V(P[i][0], P[i][1], z1), new V(P[j][0], P[j][1], z1), new V(P[k][0], P[k][1], z1)]); if (top) out.push(top);
      const bot = Poly.make([new V(P[k][0], P[k][1], z0), new V(P[j][0], P[j][1], z0), new V(P[i][0], P[i][1], z0)]); if (bot) out.push(bot);
    }
    return out;
  }
  // box oriented through a side wall: centre (x,y,z), size along the wall u, through-wall depth, height h
  function wallBox(cx, cy, cz, u, depth, h, side, round) {
    const horiz = side === 'top' || side === 'bottom';   // board top/bottom edge → wall runs along x
    const w2 = horiz ? u / 2 : depth / 2, d2 = horiz ? depth / 2 : u / 2;
    if (round) {
      // circular hole through the wall: build a cylinder along the wall normal
      const pts = circle(0, 0, Math.min(u, h) / 2, 28), polys = [], n = pts.length;
      const map = (s, t, k) => horiz ? new V(cx + s, cy + k, cz + t) : new V(cx + k, cy + s, cz + t);
      const ring = k => pts.map(p => map(p[0], p[1], k));
      const A = ring(-depth / 2), B = ring(depth / 2);
      for (let i = 0; i < n; i++) { const j = (i + 1) % n; const q = Poly.make([A[i], A[j], B[j], B[i]]); if (q) polys.push(q); }
      const ca = Poly.make(A.slice().reverse()), cb = Poly.make(B.slice());
      // orient caps / sides outward by checking against the centre
      const fix = (p, c) => { if (p && p.plane.n.dot(p.v[0].minus(c)) < 0) p.flip(); return p; };
      const ctr = new V(cx, cy, cz);
      polys.forEach(p => fix(p, ctr)); if (ca) polys.push(fix(ca, ctr)); if (cb) polys.push(fix(cb, ctr));
      return polys;
    }
    return prism(rect(cx - w2, cy - d2, cx + w2, cy + d2), cz - h / 2, cz + h / 2);
  }

  // ---------------- part heights (mm above the board) ----------------
  const partText = c => { const lib = c.lcsc && Model.S.lib && Model.S.lib[c.lcsc]; return [c.footprint, c.value, c.type, lib && lib.name, lib && lib.package, lib && lib.footprint && lib.footprint.name].filter(Boolean).join(' ').toUpperCase(); };
  // plug-in modules soldered onto the board: real body size (their footprints usually cover more — courtyard, the USB
  // overhang) and the USB port on the short side next to pin 1 (true for XIAO, Pico, Pro Micro, Nano, SuperMini, Zero)
  // fromTop: port centre below the module top; out: how far the receptacle reaches past the module's edge
  const MODULES = [
    { re: /XIAO/, name: 'Seeed XIAO', body: [17.8, 21], h: 3.5, port: { kind: 'USB-C', w: 9.0, h: 3.2, fromTop: 1.65, out: 1.2 } },
    { re: /SUPER.?MINI/, name: 'ESP32-C3 SuperMini', body: [18, 22.5], h: 4.4, port: { kind: 'USB-C', w: 9.0, h: 3.2, fromTop: 1.6, out: 1.0 } },
    { re: /RP2040.?ZERO|ESP32-?S3.?ZERO|WAVESHARE.?ZERO/, name: 'Waveshare Zero', body: [18, 23.5], h: 4.4, port: { kind: 'USB-C', w: 9.0, h: 3.2, fromTop: 1.6, out: 0.8 } },
    { re: /RASPBERRY.?PI.?PICO|RPI.?PICO|\bPICO(.?W|.?2)?\b/, name: 'Raspberry Pi Pico', body: [21, 51], h: 3.9, port: { kind: 'micro-USB', w: 8.0, h: 2.9, fromTop: 1.45, out: 1.3 } },
    { re: /PRO.?MICRO/, name: 'Pro Micro', body: [18, 33], h: 4.3, port: { kind: 'USB', w: 8.0, h: 3.0, fromTop: 1.5, out: 1.0 } },
    { re: /ARDUINO.?NANO|NANO.?V3/, name: 'Arduino Nano', body: [18, 45], h: 5.5, port: { kind: 'mini-USB', w: 7.8, h: 4.0, fromTop: 2.0, out: 1.5 } },
  ];
  // the part's own mechanical data: the project's override (set_enclosure partBodies) or the part library (create_part mech)
  // body {w, l, h} (w along x, l along y as the footprint is drawn), connectors [{type, side: 'pin1' | board side, w, h, z (centre above the board), out}]
  function mechOf(c) {
    const pb = ((Model.S.enclosure || {}).partBodies || {})[c.ref], lib = c.lcsc && Model.S.lib && Model.S.lib[c.lcsc];
    return pb || (lib && lib.mech) || null;
  }
  // body box and port of a known module, in board coordinates (y down); null for anything else
  function moduleInfo(c) {
    const mech = mechOf(c);
    if (mech && mech.body) {
      const pads = Pcb.padsOf(c); if (!pads.length) return null;
      const xs = pads.map(q => q.x), ys = pads.map(q => q.y), cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
      const turned = Math.round(((c.pcb && c.pcb.rot) || 0) / 90) % 2 !== 0, bw = turned ? +mech.body.l : +mech.body.w, bl = turned ? +mech.body.w : +mech.body.l, h = +mech.body.h || 0;
      const body = [cx - bw / 2, cy - bl / 2, cx + bw / 2, cy + bl / 2], k = (mech.connectors || [])[0];
      let port = null;
      if (k) {
        let side = k.side && k.side !== 'pin1' ? k.side : null;
        if (!side) { const p1 = pads.find(q => String(q.num) === '1') || pads[0], longY = bl >= bw; side = longY ? (p1.y < cy ? 'top' : 'bottom') : (p1.x < cx ? 'left' : 'right'); }
        port = { kind: k.type || 'connector', side, along: side === 'top' || side === 'bottom' ? (k.at ?? cx) : (k.at ?? cy), w: +k.w || 9, h: +k.h || 3.2, fromTop: h - (k.z ?? h / 2), out: +k.out || 1 };
      }
      return { name: c.value || c.ref, body, h, port };
    }
    const M = MODULES.find(m => m.re.test(partText(c))); if (!M) return null;
    const pads = Pcb.padsOf(c); if (pads.length < 4) return null;
    // the pin rows: the pads of the most common size (castellations / header pins, not the pads underneath)
    const key = q => (+q.w).toFixed(2) + 'x' + (+q.h).toFixed(2), n = {};
    for (const q of pads) n[key(q)] = (n[key(q)] || 0) + 1;
    const top = Object.entries(n).sort((a, b) => b[1] - a[1])[0][0], rows = pads.filter(q => key(q) === top);
    const xs = rows.map(q => q.x), ys = rows.map(q => q.y), cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    // pins run along the long side: two columns (few distinct x) → long axis along y
    const distinct = v => new Set(v.map(a => Math.round(a * 2))).size, longY = distinct(xs) <= distinct(ys);
    const [bw, bl] = longY ? [M.body[0], M.body[1]] : [M.body[1], M.body[0]];
    const body = [cx - bw / 2, cy - bl / 2, cx + bw / 2, cy + bl / 2];
    const p1 = pads.find(q => String(q.num) === '1') || rows[0];
    const side = longY ? (p1.y < cy ? 'top' : 'bottom') : (p1.x < cx ? 'left' : 'right');
    return { name: M.name, body, h: M.h, port: Object.assign({ side, along: longY ? cx : cy }, M.port) };
  }
  function partHeight(c, params) {
    if (params.partHeights && params.partHeights[c.ref] != null) return +params.partHeights[c.ref];
    const t = partText(c), fp = Lib.footprint(c.footprint), mech = mechOf(c);
    if (mech && mech.body && +mech.body.h) return +mech.body.h;
    const M = MODULES.find(m => m.re.test(t)); if (M) return M.h;
    // pads only (wire pads, test points, electrode pads, solder jumpers): nothing stands on the board
    if (fp && fp.pads.length && fp.pads.length <= 4 && fp.pads.every(q => !q.drill) && /PAD|ELECTRODE|TEST.?POINT|\bTP\d|WIRE|SOLDER|JUMPER/.test(t) && !/HOLDER|HEADER|JST|USB|SPRING|POGO/.test(t)) return 0.1;
    // EasyEDA package names often carry the height: …-H1.2
    const mh = t.match(/[-_]H(\d+(?:\.\d+)?)(?=[-_ ]|$)/); if (mh && +mh[1] > 0.1 && +mh[1] < 40) return +mh[1];
    // coin-cell holders: holder + cell (LIR2032 / CR2032 in a Keystone 3034-type holder ≈ 4.4 mm)
    const tests = [[/CR-?2450|LIR-?2450/, 5.6], [/CR-?20(32|25|16)|LIR-?20(32|25)|2032|COIN|BATTERY.?HOLDER|BAT.?HLD|KEYSTONE.?30[0-9]{2}/, 4.4], [/CR-?1[0-9]20|LIR-?1[0-9]20/, 3.2], [/18650/, 21], [/AA|AA.?HOLDER/, 16], [/AAA/, 13], [/TO-?220/, 18], [/DC-?0|BARREL|JACK/, 11], [/RJ-?45/, 13.5], [/BUZZER/, 9.5], [/POT/, 10], [/PINHEADER|HEADER|CONN/, 8.5],
      [/CAPACITOR_POLARIZED|ELECTROLYTIC|CP_RADIAL/, 11], [/TYPE-?C|USB-?C/, 3.3], [/MICRO-?USB|MICRO-?B/, 2.9], [/USB/, 7], [/ESP32|WROOM|MINI-1|MODULE|WIFIM/, 3.3],
      [/TO-?92/, 5], [/DIP-/, 4.5], [/SW_|SWITCH|TACT/, 5], [/SOT-?223/, 1.8], [/THT_P2\.54/, 8.6], [/THT_P/, 6]];
    for (const [re, h] of tests) if (re.test(t)) return h;
    // SMD crystals / oscillators by their size (5032 → 1.2, 3225 → 1.0, 2520 → 0.8, 2016 → 0.6); HC-49 through-hole 4
    if (/OSC|XTAL|CRYSTAL|\bXO\b|TCXO|RESONATOR/.test(t)) {
      const L = (t.match(/L(\d+(?:\.\d+)?)-W\d/) || [])[1] || ({ 7050: 7, 5032: 5, 3225: 3.2, 2520: 2.5, 2016: 2, 1612: 1.6 }[(t.match(/\b(7050|5032|3225|2520|2016|1612)\b/) || [])[1]]);
      if (L) return L >= 6 ? 1.6 : L >= 4.5 ? 1.2 : L >= 3 ? 1.0 : L >= 2.4 ? 0.8 : L >= 1.9 ? 0.6 : 0.5;
      if (/HC-?49/.test(t)) return 4;
    }
    // chip passives by size: resistor / capacitor / anything else (inductors, ferrites, LEDs)
    for (const [z, r, cp, o] of [['0201', 0.3, 0.3, 0.35], ['0402', 0.35, 0.55, 0.6], ['0603', 0.5, 0.8, 0.9], ['0805', 0.6, 1.25, 1.1], ['1206', 0.6, 1.6, 1.2], ['1210', 0.6, 2.0, 1.5], ['2512', 0.7, 2.5, 2.0]])
      if (new RegExp('(^|[^0-9.])' + z + '([^0-9]|$)').test(t)) return c.type === 'resistor' ? r : /capacitor/.test(c.type || '') ? cp : o;
    for (const [re, h] of [[/MSOP|VSSOP/, 1.1], [/TSSOP|TSOP/, 1.2], [/SSOP/, 2.0], [/SOIC|\bSOP-?\d|SO-?\d/, 1.75], [/UDFN|USON|X2SON|XSON/, 0.6], [/WSON|VSON|\bSON-|DFN/, 0.8],
      [/QFN/, 0.9], [/LGA/, 1.0], [/WLCSP|\bCSP/, 0.6], [/TQFP/, 1.2], [/LQFP/, 1.6], [/QFP/, 2.0], [/SOT-?(563|666|953)/, 0.6], [/SOT-?23|SOT-?323|SOT-?363|SC-?70|SC-?88/, 1.1],
      [/SOT-?89/, 1.6], [/SOD-?(523|923)/, 0.7], [/SOD-?323/, 0.95], [/SOD-?123/, 1.2], [/\bSMA\b|DO-?214AC/, 2.3], [/\bSM[BC]\b|DO-?214A[AB]/, 2.4], [/CRYSTAL|HC49/, 4]])
      if (re.test(t)) return h;
    return fp && fp.pads.some(q => q.drill) ? 6 : 1.6;
  }

  // ---------------- batteries (loose cells that live in the enclosure, wired to the board) ----------------
  // Sizes are the cell's own (LiPo: incl. the protection board, without the wire). Capacities are typical market
  // values: check the seller's datasheet. kind: coin (d × t), lipo (pouch t × w × l, named TTWWLL: thickness in 0.1 mm, a leading 10 = 10 mm), cyl (d × l).
  const LIION = 'Li-ion rechargeable, 3.7 V nominal, 4.2 V full: needs a Li-ion charger (TP4054 / MCP73831 / BQ24075) and a protection circuit (LiPo packs include one)';
  const BATTERIES = [
    ...[['LIR1220', 12.5, 2.0, 8], ['LIR1632', 16, 3.2, 25], ['LIR2025', 20, 2.5, 30], ['LIR2032', 20, 3.2, 40], ['LIR1254', 12, 5.4, 60], ['LIR2450', 24.5, 5.0, 120], ['LIR2477', 24.5, 7.7, 180]]
      .map(([n, d, t, mAh]) => ({ id: n.toLowerCase(), name: n, kind: 'coin', d, t, mAh, V: 3.7, rechargeable: true, max_mA: Math.round(mAh * 0.5), note: 'rechargeable Li-ion coin cell (tabbed version to solder wires); charge ≤ 0.5 C at 4.2 V. ' + LIION })),
    ...[['CR1220', 12.5, 2.0, 40, 1], ['CR1632', 16, 3.2, 140, 2], ['CR2032', 20, 3.2, 225, 3], ['CR2450', 24.5, 5.0, 620, 5], ['CR2477', 24.5, 7.7, 1000, 5]]
      .map(([n, d, t, mAh, cont]) => ({ id: n.toLowerCase(), name: n, kind: 'coin', d, t, mAh, V: 3.0, rechargeable: false, max_mA: cont, note: `primary (not rechargeable) lithium 3 V coin; ~${cont} mA continuous, short pulses ~15 mA with a large capacitor — fine for BLE beacons / sensors, not for radios that stream` })),
    ...[['301020', 45], ['302020', 70], ['401020', 60], ['401030', 100], ['401230', 150], ['402020', 100], ['402030', 180], ['501520', 90], ['502020', 140], ['502030', 250], ['502535', 400], ['503035', 500], ['602025', 200], ['523450', 1000], ['603450', 1200], ['803450', 1500], ['103450', 1800], ['102050', 1000]]
      .map(([c, mAh]) => { const t = c.startsWith('10') ? 10 : +c.slice(0, 2) / 10, w = +c.slice(2, 4), l = +c.slice(4, 6); return { id: 'lipo-' + c, name: `LiPo ${c} (${t} × ${w} × ${l} mm)`, kind: 'lipo', t, w, l, mAh, V: 3.7, rechargeable: true, max_mA: mAh, note: 'LiPo pouch with protection board and JST-PH 2.0 / wire leads; 1 C continuous; leave ~0.5 mm around it (pouches swell). ' + LIION }; }),
    ...[['10440', 10, 44, 350], ['14500', 14, 50, 800], ['16340', 16, 34, 700], ['18350', 18, 35, 900], ['18650', 18.4, 65, 3000], ['21700', 21, 70, 4500]]
      .map(([n, d, l, mAh]) => ({ id: n, name: `${n} Li-ion cell (Ø${d} × ${l} mm)`, kind: 'cyl', d, l, mAh, V: 3.7, rechargeable: true, max_mA: Math.round(mAh * (+n > 18000 ? 2 : 1)), note: 'cylindrical Li-ion; use a protected cell or add a protection IC (DW01 + FS8205), holder or nickel strip. ' + LIION })),
  ];
  // footprint of a battery lying flat: w (x) × l (y) × t (z)
  // id from the list, any LiPo size code (lipo-TTWWLL), or your own cell {t, w, l, mAh?, kind?: 'lipo' | 'coin' | 'cyl', name?}
  const lipoCode = c => { const t = c.startsWith('10') ? 10 : +c.slice(0, 2) / 10, w = +c.slice(2, 4), l = +c.slice(4, 6); return { t, w, l }; };
  function battery(id) {
    if (id && typeof id === 'object' && id.w != null && id.l != null && id.t != null && id.kind && id.Wh != null) return id;   // already resolved
    if (id && typeof id === 'object') {
      const kind = id.kind || (id.d ? (id.l ? 'cyl' : 'coin') : 'lipo'), t = +(id.t ?? id.d), w = +(id.w ?? id.d), l = +(id.l ?? id.d);
      if (!(t > 0 && w > 0 && l > 0)) throw new Error('custom battery: give {t, w, l} in mm (or {d, t} for a coin, {d, l} for a cylinder)');
      const mAh = +id.mAh || Math.round(w * l * t / 1000 * 85);   // ≈ 85 mAh per cm³ for small LiPo pouches
      return { id: 'custom', name: id.name || `custom ${kind} ${t} × ${w} × ${l} mm`, kind, t: kind === 'cyl' ? w : t, w, l, d: id.d, mAh, V: 3.7, rechargeable: id.rechargeable !== false, max_mA: +id.max_mA || mAh, Wh: +(mAh * 3.7 / 1000).toFixed(2), estimated: !id.mAh, note: 'custom size' + (id.mAh ? '' : ' — capacity estimated from the volume (≈ 85 mAh/cm³); use the seller’s value') };
    }
    const k = String(id || '').toLowerCase().replace(/^lipo[-_ ]?/, 'lipo-').replace(/\s+/g, '');
    let b = BATTERIES.find(x => x.id === k || x.id === 'lipo-' + k || x.name.toLowerCase() === k);
    if (!b && /^(lipo-)?\d{6}$/.test(k)) { const c = k.replace('lipo-', ''), d = lipoCode(c); return battery({ kind: 'lipo', name: `LiPo ${c} (${d.t} × ${d.w} × ${d.l} mm, not in the list)`, ...d }); }
    if (!b) throw new Error(`Unknown battery "${id}". Known: ${BATTERIES.map(x => x.id).join(', ')} — or any LiPo code (lipo-302020) or your own size {t, w, l, mAh}`);
    const dims = b.kind === 'coin' ? { w: b.d, l: b.d, t: b.t } : b.kind === 'cyl' ? { w: b.d, l: b.l, t: b.d } : { w: b.w, l: b.l, t: b.t };
    return Object.assign({}, b, dims, { Wh: +(b.mAh * b.V / 1000).toFixed(2) });
  }
  // catalogue filtered and sorted for a choice: capacity, size limits, the current the design draws → runtime
  function batteries(q = {}) {
    let L = BATTERIES.map(b => battery(b.id));
    if (q.kind) L = L.filter(b => b.kind === q.kind);
    if (q.rechargeable != null) L = L.filter(b => b.rechargeable === !!q.rechargeable);
    if (q.min_mAh) L = L.filter(b => b.mAh >= q.min_mAh);
    if (q.max_thickness) L = L.filter(b => b.t <= q.max_thickness);
    if (q.max_width || q.max_length) { const a = Math.min(q.max_width || 1e9, q.max_length || 1e9), c = Math.max(q.max_width || 0, q.max_length || 0) || a; L = L.filter(b => Math.min(b.w, b.l) <= a && Math.max(b.w, b.l) <= c); }
    if (q.peak_mA) L = L.filter(b => b.max_mA >= q.peak_mA);
    // charge rate: the charger's current against the capacity (LiPo ≤ 1 C, LIR coins ≤ 0.5 C)
    const chg = b => { if (!q.charge_mA || !b.rechargeable) return {}; const C = q.charge_mA / b.mAh, lim = b.kind === 'coin' ? 0.5 : 1; return { charge_C: +C.toFixed(2), charge_ok: C <= lim + 1e-9, charge_note: C > lim ? `${q.charge_mA} mA is ${C.toFixed(1)} C — above ${lim} C for this cell: lower the charge current (charger's PROG resistor) or pick a bigger cell` : undefined }; };
    return L.sort((a, b) => a.mAh - b.mAh).map(b => Object.assign({ id: b.id, name: b.name, kind: b.kind, size_mm: b.kind === 'coin' ? `Ø${b.d} × ${b.t}` : b.kind === 'cyl' ? `Ø${b.d} × ${b.l}` : `${b.t} × ${b.w} × ${b.l}`, mAh: b.mAh, V: b.V, Wh: b.Wh, rechargeable: b.rechargeable, max_mA: b.max_mA, volume_cm3: +(b.w * b.l * b.t / 1000).toFixed(2) },
      q.avg_mA ? { runtime_h: +(b.mAh * 0.85 / q.avg_mA).toFixed(1) } : {}, chg(b), q.verbose ? { note: b.note } : {}));
  }

  // ---------------- parameters ----------------
  const DEFAULTS = {
    wall: 2.0, floor: 2.0, lidThickness: 2.0, clearance: 1.0, pcbThickness: 1.6, topClearance: 3.0, extraHeight: 0,
    standoffHeight: 5.0, standoffDiameter: 6.0, screwHole: 2.5, lidFit: 0.3, lipHeight: 3.0, lipWidth: 1.2,
    vents: true, ventWidth: 1.6, ventLength: 18, ventSpacing: 3.5, autoConnectorCutouts: true, autoLidHoles: true,
    cutouts: [], partHeights: {}, explode: 12,
    battery: '', batteryPlace: 'under', process: 'mjf', partBodies: {},
    // the project's manufacturing rules (F18): stricter defaults the enclosure tools apply — minWall, fit, minRidge, minPart [a, b, c]
    rules: {},   // process: mjf | sls | sla | fdm — the manufacturability check's limits   // loose cell in the box (see batteries()): under the board, beside it (+X) or above the parts
  };
  const params = () => Object.assign({}, DEFAULTS, Model.S.enclosure || {}, { partBodies: Object.assign({}, (Model.S.enclosure || {}).partBodies || {}), rules: Object.assign({}, (Model.S.enclosure || {}).rules || {}), cutouts: ((Model.S.enclosure || {}).cutouts || []).slice(), partHeights: Object.assign({}, (Model.S.enclosure || {}).partHeights || {}) });
  function setParams(u = {}) {
    const S = Model.S, cur = Object.assign({}, S.enclosure || {});
    for (const [k, v] of Object.entries(u)) {
      // mode: 'box' = this parametric box, 'custom' = free-form 3D script (shape3d.js) stored in .script
      if (k === 'mode') { if (!['box', 'custom'].includes(v)) throw new Error('mode must be "box" or "custom"'); cur.mode = v; continue; }
      if (k === 'script') { cur.script = String(v || ''); continue; }
      if (k === 'battery') { if (v) battery(v); cur.battery = !v ? '' : typeof v === 'object' ? v : battery(v).id === 'custom' ? v : battery(v).id; continue; }
      if (k === 'process') { if (!['mjf', 'sls', 'sla', 'fdm'].includes(v)) throw new Error('process must be mjf, sls, sla or fdm'); cur.process = v; continue; }
      if (k === 'batteryPlace') { if (!['under', 'beside', 'above'].includes(v)) throw new Error('batteryPlace must be under, beside or above'); cur.batteryPlace = v; continue; }
      if (!(k in DEFAULTS)) throw new Error(`Unknown enclosure parameter "${k}". Known: mode, script, ${Object.keys(DEFAULTS).join(', ')}`);
      if (k === 'partBodies' || k === 'rules') { cur[k] = Object.assign({}, cur[k] || {}); for (const [r, h] of Object.entries(v || {})) { if (h == null || h === '') delete cur[k][r]; else cur[k][r] = h; } continue; }
      if (k === 'partHeights') { cur.partHeights = Object.assign({}, cur.partHeights || {}); for (const [r, h] of Object.entries(v || {})) { if (h == null || h === '') delete cur.partHeights[r]; else cur.partHeights[r] = +h; } }
      else if (k === 'cutouts') cur.cutouts = v;
      else if (typeof DEFAULTS[k] === 'boolean') cur[k] = !!v;
      else { const n = +v; if (!(n >= 0 && n < 500)) throw new Error(`${k} must be a number in mm`); cur[k] = n; }
    }
    S.enclosure = cur;
    try { return describe(); } catch (e) { if ('mode' in u || 'script' in u) return { mode: cur.mode || 'box' }; throw e; }
  }
  const mode = () => (Model.S.enclosure || {}).mode || 'box', script = () => (Model.S.enclosure || {}).script || '';
  function addCutout(c) {
    const S = Model.S, cur = Object.assign({}, S.enclosure || {});
    const side = String(c.side || '').toLowerCase();
    if (!['left', 'right', 'front', 'back', 'lid', 'floor'].includes(side)) throw new Error('side must be left, right, front, back, lid or floor');
    const cut = { side, shape: c.shape === 'circle' ? 'circle' : 'rect', w: +c.width || +c.w || 5, h: +c.height || +c.h || +c.width || 5, label: c.label || '' };
    if (side === 'lid' || side === 'floor') { cut.x = +c.x || 0; cut.y = +c.y || 0; } else { cut.u = +c.u || +c.position || 0; cut.z = c.z != null ? +c.z : null; }
    cur.cutouts = (cur.cutouts || []).concat([cut]); S.enclosure = cur;
    return { index: cur.cutouts.length - 1, cutout: cut };
  }

  const NORMAL2 = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };
  function hull2(P) {   // convex hull (monotone chain), CCW
    P = P.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]), lo = [], up = [];
    for (const p of P) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (const p of P.slice().reverse()) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
    return lo.slice(0, -1).concat(up.slice(0, -1));
  }
  // ---------------- model ----------------
  // board coords (x right, y down) → enclosure coords (x right, y up)
  function layout() {
    const S = Model.S, P = params();
    if (!S.board.w || !Pcb.placed().length) throw new Error('Generate the PCB first — the enclosure is fitted to it');
    const bpoly = Pcb.boardPoly().map(q => [q[0], -q[1]]);
    const cs = Pcb.placed();
    let topH = 0, botH = 0;
    const bb = Pcb.boardPoly(), bX0 = Math.min(...bb.map(q => q[0])), bX1 = Math.max(...bb.map(q => q[0])), bY0 = Math.min(...bb.map(q => q[1])), bY1 = Math.max(...bb.map(q => q[1]));
    const parts = cs.map(c => {
      const mod = moduleInfo(c), b = mod ? mod.body : Pcb.fpBox(c), h = partHeight(c, P), bottom = Pcb.isBottom(c);
      if (bottom) botH = Math.max(botH, h); else topH = Math.max(topH, h);
      const tht = Pcb.padsOf(c).some(p => p.drill); if (tht && !bottom) botH = Math.max(botH, 1.8); // leads under the board
      let edge = Pcb.edgeInfo(c), port = null;
      if (mod && mod.port) {
        // a module's USB port opens to the outside when the module sits within 3 mm of that board edge
        const q = mod.port, gap = { left: b[0] - bX0, right: bX1 - b[2], top: b[1] - bY0, bottom: bY1 - b[3] }[q.side];
        if (gap < 3) {
          const zc = h - q.fromTop, e = { left: [b[0], -q.along], right: [b[2], -q.along], top: [q.along, -b[1]], bottom: [q.along, -b[3]] }[q.side];
          port = { kind: q.kind, side: { left: 'left', right: 'right', top: 'back', bottom: 'front' }[q.side], x: e[0], y: e[1], zc, w: q.w, h: q.h, out: q.out, module: mod.name };
          edge = { plug: true, front: NORMAL2[q.side], port: true };
        }
      }
      return { ref: c.ref, value: c.value, type: c.type, x0: b[0], x1: b[2], y0: -b[3], y1: -b[1], h, bottom, edge, port, module: mod && mod.name, c };
    });
    // a loose battery: under the board (the standoffs lift the PCB over it), beside it (+X) or on top of the parts
    const bt = P.battery ? battery(P.battery) : null, bx = Math.min(...bpoly.map(q => q[0])), bX = Math.max(...bpoly.map(q => q[0])), by = Math.min(...bpoly.map(q => q[1])), bY = Math.max(...bpoly.map(q => q[1]));
    const standoff = Math.max(P.standoffHeight, botH + 1.0, bt && P.batteryPlace === 'under' ? botH + bt.t + 1.2 : 0);
    const pcbZ = P.floor + standoff, pcbTop = pcbZ + P.pcbThickness;
    let H = +(pcbTop + topH + P.topClearance + P.extraHeight + (bt && P.batteryPlace === 'above' ? bt.t + 0.8 : 0)).toFixed(2);
    let bat = null, fp = bpoly;
    if (bt) {
      // the longer side of the cell along the board's longer side
      const [w, l] = (bX - bx >= bY - by) === (bt.w >= bt.l) ? [bt.w, bt.l] : [bt.l, bt.w], cx = (bx + bX) / 2, cy = (by + bY) / 2;
      const x0 = P.batteryPlace === 'beside' ? bX + 1.5 : cx - w / 2, y0 = cy - l / 2;
      const z0 = P.batteryPlace === 'above' ? pcbTop + topH + 0.4 : P.floor + 0.2;
      bat = Object.assign({}, bt, { x0, y0, x1: x0 + w, y1: y0 + l, z0, z1: z0 + bt.t, place: P.batteryPlace });
      if (P.batteryPlace === 'beside') H = Math.max(H, +(P.floor + bt.t + P.topClearance).toFixed(2));
      // the cavity grows to hold the cell: outline = board outline joined with the battery rectangle
      const r = [[bat.x0, bat.y0], [bat.x1, bat.y0], [bat.x1, bat.y1], [bat.x0, bat.y1]];
      if (bat.x0 < bx || bat.x1 > bX || bat.y0 < by || bat.y1 > bY) fp = hull2([...bpoly, ...r]);
    }
    const inner = offset(fp, P.clearance), outer = offset(fp, P.clearance + P.wall);
    const xs = outer.map(q => q[0]), ys = outer.map(q => q[1]);
    const holes = (S.pcb.holes || []).map(h => ({ x: h.x, y: -h.y, d: h.d }));
    return { P, bpoly, inner, outer, parts, standoff, pcbZ, pcbTop, H, topH, botH, holes, battery: bat, bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
  }
  // where each side wall is (in enclosure coords) and which board coordinate runs along it
  function sideInfo(L, side) {
    const [x0, y0, x1, y1] = L.bbox, t = L.P.wall + L.P.clearance;
    if (side === 'left') return { wx: x0 + L.P.wall / 2, axis: 'y', mid: (y0 + y1) / 2, bside: 'left' };
    if (side === 'right') return { wx: x1 - L.P.wall / 2, axis: 'y', mid: (y0 + y1) / 2, bside: 'right' };
    if (side === 'back') return { wy: y1 - L.P.wall / 2, axis: 'x', mid: (x0 + x1) / 2, bside: 'top' };    // board top edge (y = 0)
    return { wy: y0 + L.P.wall / 2, axis: 'x', mid: (x0 + x1) / 2, bside: 'bottom' };                     // front = board bottom edge
  }
  function cutoutList(L) {
    const P = L.P, out = [];
    if (P.autoConnectorCutouts) for (const p of L.parts) {
      if (!p.edge || !p.edge.plug || p.bottom) continue;
      if (p.port) {   // a module's USB port: its own size and height, not the module's
        const q = p.port, horiz = q.side === 'front' || q.side === 'back';
        out.push({ auto: true, ref: p.ref, side: q.side, shape: 'rect', centre: horiz ? q.x : q.y, w: q.w + 1.2, h: q.h + 1.2, z: L.pcbTop + q.zc, label: `${p.ref} ${q.kind} (${q.module})` });
        continue;
      }
      const c = p.c, b = Pcb.fpBox(c), S = Model.S;
      const d = { left: b[0], right: S.board.w - b[2], back: b[1], front: S.board.h - b[3] };
      const side = Object.entries(d).sort((a, q) => a[1] - q[1])[0][0];
      const horiz = side === 'front' || side === 'back';
      const along = horiz ? (b[0] + b[2]) / 2 : -(b[1] + b[3]) / 2, size = horiz ? b[2] - b[0] : b[3] - b[1];
      out.push({ auto: true, ref: p.ref, side, shape: 'rect', centre: along, w: size + 1.2, h: p.h + 1.2, z: L.pcbTop + p.h / 2, label: `${p.ref} ${p.value || ''}`.trim() });
    }
    if (P.autoLidHoles) for (const p of L.parts) {
      if (p.bottom) continue;
      const cx = (p.x0 + p.x1) / 2, cy = (p.y0 + p.y1) / 2;
      if (p.type === 'led') out.push({ auto: true, ref: p.ref, side: 'lid', shape: 'circle', x: cx, y: cy, w: 3.4, h: 3.4, label: `${p.ref} LED` });
      if (p.type === 'switch') out.push({ auto: true, ref: p.ref, side: 'lid', shape: 'circle', x: cx, y: cy, w: 4.0, h: 4.0, label: `${p.ref} button` });
    }
    for (const c of P.cutouts) {
      if (c.side === 'lid' || c.side === 'floor') out.push(Object.assign({}, c, { x: c.x, y: c.y }));
      else { const si = sideInfo(L, c.side); out.push(Object.assign({}, c, { centre: si.mid + (c.u || 0), z: c.z != null ? c.z : L.pcbTop + 4 })); }
    }
    return out;
  }
  function build(opts = {}) {
    const L = layout(), P = L.P, H = L.H;
    // base: outer shell minus cavity
    let base = subtract(prism(L.outer, 0, H), prism(L.inner, P.floor, H + 1));
    // standoffs at mounting holes, or corner supports when the board has none
    const sup = L.holes.length ? L.holes : supportPoints(L);
    let posts = [];
    for (const h of sup) posts = posts.concat(prism(circle(h.x, h.y, P.standoffDiameter / 2, 24), P.floor - 0.01, P.floor + L.standoff));
    if (posts.length) base = union(base, posts);
    if (L.holes.length) { let sc = []; for (const h of L.holes) sc = sc.concat(prism(circle(h.x, h.y, P.screwHole / 2, 20), P.floor + 0.8, P.floor + L.standoff + 0.5)); base = subtract(base, sc); }
    // wall / floor cutouts
    const cuts = cutoutList(L);
    for (const c of cuts) {
      if (c.side === 'lid') continue;
      if (c.side === 'floor') { const g = c.shape === 'circle' ? circle(c.x, c.y, c.w / 2) : rect(c.x - c.w / 2, c.y - c.h / 2, c.x + c.w / 2, c.y + c.h / 2); base = subtract(base, prism(g, -1, P.floor + 0.5)); continue; }
      const si = sideInfo(L, c.side), depth = P.wall * 2 + P.clearance + 4;
      const cx = si.axis === 'x' ? c.centre : si.wx, cy = si.axis === 'y' ? c.centre : si.wy;
      // wall cutouts open at the top when they would reach the rim (easier to print, lets the board drop in)
      const zTop = Math.min(c.z + c.h / 2, H + 1), zBot = c.z - c.h / 2, hh = zTop - zBot;
      base = subtract(base, wallBox(cx, cy, zBot + hh / 2, c.w, depth, hh, si.axis === 'x' ? 'top' : 'left', c.shape === 'circle'));
    }
    // lid (assembled orientation: plate on top of the walls, lip hanging into the cavity)
    const lipOut = offset(L.bpoly, P.clearance - P.lidFit), lipIn = offset(L.bpoly, P.clearance - P.lidFit - P.lipWidth);
    let lid = union(prism(L.outer, H, H + P.lidThickness), subtract(prism(lipOut, H - P.lipHeight, H + 0.01), prism(lipIn, H - P.lipHeight - 1, H + 1)));
    let holesLid = [];
    for (const c of cuts) if (c.side === 'lid') holesLid = holesLid.concat(prism(c.shape === 'circle' ? circle(c.x, c.y, c.w / 2) : rect(c.x - c.w / 2, c.y - c.h / 2, c.x + c.w / 2, c.y + c.h / 2), H - P.lipHeight - 1, H + P.lidThickness + 1));
    if (P.vents) holesLid = holesLid.concat(ventSlots(L, cuts));
    if (holesLid.length) lid = subtract(lid, holesLid);
    return { L, base: repair(base), lid: repair(lid), cuts };
  }
  function supportPoints(L) {
    // small posts under the board corners (inset) when the PCB has no mounting holes
    const bx = L.bpoly.map(q => q[0]), by = L.bpoly.map(q => q[1]), i = Math.min(3, L.P.standoffDiameter / 2 + 0.5);
    const pts = [[Math.min(...bx) + i, Math.min(...by) + i], [Math.max(...bx) - i, Math.min(...by) + i], [Math.max(...bx) - i, Math.max(...by) - i], [Math.min(...bx) + i, Math.max(...by) - i]];
    return pts.filter(([x, y]) => inPoly2(x, y, L.bpoly)).map(([x, y]) => ({ x, y }));
  }
  function inPoly2(x, y, poly) { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; }
  function ventSlots(L, cuts) {
    const P = L.P, inner = offset(L.bpoly, P.clearance - (P.lidFit + P.lipWidth + 2.5)), xs = inner.map(q => q[0]), ys = inner.map(q => q[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, len = Math.min(P.ventLength, (Math.max(...xs) - Math.min(...xs)) * 0.6);
    const out = [], H = L.H, keep = cuts.filter(c => c.side === 'lid');
    for (let y = Math.min(...ys) + P.ventSpacing; y < Math.max(...ys) - P.ventSpacing / 2; y += P.ventSpacing) {
      const x0 = cx - len / 2, x1 = cx + len / 2;
      if (![[x0, y], [x1, y]].every(([x, yy]) => inPoly2(x, yy, inner))) continue;
      if (keep.some(c => Math.abs(c.y - y) < c.w / 2 + P.ventWidth && c.x > x0 - c.w && c.x < x1 + c.w)) continue;
      out.push(...prism(rect(x0, y - P.ventWidth / 2, x1, y + P.ventWidth / 2), H - 0.5, H + P.lidThickness + 1));
    }
    return out;
  }

  // ---------------- mesh repair ----------------
  // Weld vertices and split edges that have another vertex lying on them (T-junctions left by the BSP booleans),
  // so the exported mesh is watertight: every edge is shared by exactly two faces.
  function repair(polys) {
    const q = v => `${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;
    const verts = new Map();
    for (const p of polys) p.v = p.v.map(v => { const k = q(v); if (!verts.has(k)) verts.set(k, v); return verts.get(k); });
    const cell = 2, grid = new Map(), gk = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
    for (const v of verts.values()) { const k = gk(v.x, v.y, v.z); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(v); }
    const near = (a, b) => {
      const out = [], x0 = Math.floor(Math.min(a.x, b.x) / cell), x1 = Math.floor(Math.max(a.x, b.x) / cell), y0 = Math.floor(Math.min(a.y, b.y) / cell), y1 = Math.floor(Math.max(a.y, b.y) / cell), z0 = Math.floor(Math.min(a.z, b.z) / cell), z1 = Math.floor(Math.max(a.z, b.z) / cell);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > 4000) return [...verts.values()];
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) { const g = grid.get(`${x},${y},${z}`); if (g) out.push(...g); }
      return out;
    };
    const out = [];
    for (const p of polys) {
      const nv = [];
      for (let i = 0; i < p.v.length; i++) {
        const a = p.v[i], b = p.v[(i + 1) % p.v.length], ab = b.minus(a), L2 = ab.dot(ab);
        nv.push(a);
        if (L2 < 1e-12) continue;
        const on = [];
        for (const v of near(a, b)) {
          if (v === a || v === b) continue;
          const t = v.minus(a).dot(ab) / L2; if (t <= 1e-6 || t >= 1 - 1e-6) continue;
          const d = a.plus(ab.times(t)).minus(v); if (d.dot(d) < 1e-8) on.push([t, v]);
        }
        on.sort((x, y) => x[0] - y[0]); for (const [, v] of on) nv.push(v);
      }
      const clean = nv.filter((v, i) => v !== nv[(i + 1) % nv.length]);
      if (clean.length >= 3) out.push(new Poly(clean, p.plane));
    }
    return out;
  }

  // Where curved surfaces meet at grazing angles, the two sides of a boolean seam get their vertices from
  // different (ill-conditioned) plane intersections and end up to ~0.1 mm apart, leaving the seam unstitched.
  // Zip it: only along unpaired (open) edges, snap nearby endpoints together and insert endpoints that lie
  // close to an opposite open edge into that edge.
  function zipSeams(polys, tol = 0.1) {
    const q = v => `${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;
    const openEdges = () => {
      const dir = new Set(), out = [];
      for (const p of polys) for (let i = 0; i < p.v.length; i++) dir.add(q(p.v[i]) + '|' + q(p.v[(i + 1) % p.v.length]));
      for (const p of polys) for (let i = 0; i < p.v.length; i++) { const a = p.v[i], b = p.v[(i + 1) % p.v.length]; if (q(a) !== q(b) && !dir.has(q(b) + '|' + q(a))) out.push({ p, a, b }); }
      return out;
    };
    const cellK = (x, y, z) => `${Math.floor(x / tol)},${Math.floor(y / tol)},${Math.floor(z / tol)}`;
    for (let pass = 0; pass < 2; pass++) {
      let open = openEdges();
      if (!open.length || open.length > 50000) return polys;
      // 1) snap open-edge endpoints that are within tol of each other
      const ends = new Map(); for (const e of open) { ends.set(q(e.a), e.a); ends.set(q(e.b), e.b); }
      const grid = new Map(), rep = new Map();
      for (const v of ends.values()) { const k = cellK(v.x, v.y, v.z); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(v); }
      for (const v of ends.values()) {
        if (rep.has(v)) continue;
        const cx = Math.floor(v.x / tol), cy = Math.floor(v.y / tol), cz = Math.floor(v.z / tol);
        for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) for (const u of grid.get(`${cx + i},${cy + j},${cz + k}`) || [])
          if (u !== v && !rep.has(u) && u.minus(v).len() < tol) rep.set(u, v);
      }
      if (rep.size) for (const p of polys) p.v = p.v.map(v => rep.get(v) || v).filter((v, i, a) => v !== a[(i + 1) % a.length]);
      for (let i = polys.length - 1; i >= 0; i--) if (polys[i].v.length < 3) polys.splice(i, 1);
      // 2) T-junctions along open edges with the larger tolerance
      open = openEdges(); if (!open.length) return polys;
      const eg = new Map();
      open.forEach((e, idx) => {
        const lo = [Math.min(e.a.x, e.b.x), Math.min(e.a.y, e.b.y), Math.min(e.a.z, e.b.z)].map(c => Math.floor((c - tol) / tol)), hi = [Math.max(e.a.x, e.b.x), Math.max(e.a.y, e.b.y), Math.max(e.a.z, e.b.z)].map(c => Math.floor((c + tol) / tol));
        if ((hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1) > 20000) return;
        for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) { const k = `${x},${y},${z}`; if (!eg.has(k)) eg.set(k, []); eg.get(k).push(idx); }
      });
      const ins = new Map(); // edge index → [[t, v]]
      const pts = new Map(); for (const e of open) { pts.set(q(e.a), e.a); pts.set(q(e.b), e.b); }
      for (const v of pts.values()) for (const idx of eg.get(cellK(v.x, v.y, v.z)) || []) {
        const e = open[idx]; if (e.a === v || e.b === v) continue;
        const ab = e.b.minus(e.a), L2 = ab.dot(ab); if (L2 < 1e-12) continue;
        const t = v.minus(e.a).dot(ab) / L2; if (t <= 1e-4 || t >= 1 - 1e-4) continue;
        if (e.a.plus(ab.times(t)).minus(v).len() < tol) { if (!ins.has(idx)) ins.set(idx, []); if (!ins.get(idx).some(x => x[1] === v)) ins.get(idx).push([t, v]); }
      }
      if (!ins.size) return polys;
      const byPoly = new Map();
      for (const [idx, list] of ins) { const e = open[idx]; if (!byPoly.has(e.p)) byPoly.set(e.p, new Map()); byPoly.get(e.p).set(e.a, list.sort((x, y) => x[0] - y[0]).map(x => x[1])); }
      for (const [p, m] of byPoly) { const nv = []; for (const v of p.v) { nv.push(v); for (const w of m.get(v) || []) nv.push(w); } p.v = nv; }
    }
    return polys;
  }

  // Close the thin sliver gaps that BSP booleans leave where curved surfaces meet at grazing angles:
  // follow loops of unpaired edges and cap each loop with a fan of triangles.
  function fillHoles(polys) {
    const q = v => `${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;
    const dir = new Set();
    for (const p of polys) for (let i = 0; i < p.v.length; i++) dir.add(q(p.v[i]) + '|' + q(p.v[(i + 1) % p.v.length]));
    const open = new Map(); // start key → [{a, b}]
    let count = 0;
    for (const p of polys) for (let i = 0; i < p.v.length; i++) {
      const a = p.v[i], b = p.v[(i + 1) % p.v.length], ka = q(a), kb = q(b);
      if (ka === kb || dir.has(kb + '|' + ka)) continue;
      if (!open.has(ka)) open.set(ka, []); open.get(ka).push({ a, b, kb, used: false }); count++;
    }
    if (!count || count > 20000) return polys;
    const out = polys.slice();
    for (const list of open.values()) for (const e0 of list) {
      if (e0.used) continue;
      const loop = [e0.a]; e0.used = true; let cur = e0, ok = false;
      for (let guard = 0; guard < 2000; guard++) {
        if (cur.kb === q(e0.a)) { ok = true; break; }
        const nx = (open.get(cur.kb) || []).find(e => !e.used); if (!nx) break;
        nx.used = true; loop.push(nx.a); cur = nx;
      }
      if (!ok || loop.length < 3) continue;
      const r = loop.slice().reverse();
      for (let i = 1; i < r.length - 1; i++) { const p = Poly.make([r[0], r[i], r[i + 1]]); if (p) out.push(p); }
    }
    return out;
  }

  // ---------------- outputs ----------------
  function triangles(polys, tf) {
    const t = [];
    for (const p of polys) {
      const v = tf ? p.v.map(tf) : p.v, n = v.length;
      // start the fan at a true corner so no zero-area triangles appear along split edges
      let s0 = 0;
      for (let i = 0; i < n; i++) { const a = v[(i - 1 + n) % n], b = v[i], c = v[(i + 1) % n]; if (b.minus(a).cross(c.minus(b)).len() > 1e-9) { s0 = i; break; } }
      const r = v.slice(s0).concat(v.slice(0, s0));
      for (let i = 1; i < n - 1; i++) { const area = r[i].minus(r[0]).cross(r[i + 1].minus(r[0])).len(); if (area > 1e-12) t.push([r[0], r[i], r[i + 1]]); else t.push([r[0], r[i], r[i + 1]]); }
    }
    return t;
  }
  function stl(polys, name, tf) {
    const tris = triangles(polys, tf), buf = new ArrayBuffer(84 + tris.length * 50), dv = new DataView(buf);
    const hdr = ('CircuitPilot ' + name).slice(0, 79); for (let i = 0; i < hdr.length; i++) dv.setUint8(i, hdr.charCodeAt(i));
    dv.setUint32(80, tris.length, true);
    let o = 84;
    for (const [a, b, c] of tris) {
      let n = b.minus(a).cross(c.minus(a)); const l = n.len(); n = l > 0 ? n.times(1 / l) : n;
      for (const v of [n, a, b, c]) { dv.setFloat32(o, v.x, true); dv.setFloat32(o + 4, v.y, true); dv.setFloat32(o + 8, v.z, true); o += 12; }
      dv.setUint16(o, 0, true); o += 2;
    }
    return new Uint8Array(buf);
  }
  // lid printed upside down: flip about X and sit it on the bed
  const lidPrintTf = (L) => v => new V(v.x, -v.y, (L.H + L.P.lidThickness) - v.z);
  function exportFiles(opts = {}) {
    const r = build(), name = (Model.S.name || 'board').replace(/[^\w.-]+/g, '_');
    const files = {};
    files[name + '-enclosure-base.stl'] = stl(r.base, 'enclosure base');
    files[name + '-enclosure-lid.stl'] = stl(r.lid, 'enclosure lid', lidPrintTf(r.L));
    files[name + '-enclosure.scad'] = scad(r);
    files[name + '-enclosure-README.txt'] = readme(r);
    // STEP too (JLC3DP takes either); the lid as it prints, like its STL
    // STEP when the mesh closes into a solid (Custom 3D always does; this box's mesh may not — then STL only)
    if (typeof Shape3D !== 'undefined') for (const [k, polys] of [['base', r.base], ['lid', r.lid]]) { const st = Shape3D.stepOfPolys(`${name}-enclosure-${k}`, polys); if (st) files[`${name}-enclosure-${k}.step`] = st; }
    return { files, info: describe(r) };
  }
  const f3 = v => (+v).toFixed(3);
  function scad(r) {
    const L = r.L, P = L.P, pts = s => '[' + s.map(q => `[${f3(q[0])},${f3(q[1])}]`).join(',') + ']';
    const lines = [];
    lines.push(`// CircuitPilot enclosure for "${Model.S.name || 'board'}" — parametric OpenSCAD source (mm)`, `// Edit the parameters below and render (F6), then export STL.`, '');
    for (const k of ['wall', 'floor', 'lidThickness', 'clearance', 'pcbThickness', 'topClearance', 'standoffDiameter', 'screwHole', 'lidFit', 'lipHeight', 'lipWidth'])
      lines.push(`${k} = ${f3(P[k])};`);
    lines.push(`standoff = ${f3(L.standoff)};        // raised to clear parts under the board`, `height = ${f3(L.H)};          // base height (tallest part ${f3(L.topH)} mm + topClearance)`, `$fn = 48;`, '');
    lines.push(`pcb = ${pts(L.bpoly)};  // board outline (y up)`);
    lines.push(`holes = [${L.holes.map(h => `[${f3(h.x)},${f3(h.y)}]`).join(',')}];`);
    lines.push(`supports = [${(L.holes.length ? [] : supportPoints(L)).map(h => `[${f3(h.x)},${f3(h.y)}]`).join(',')}];`, '');
    lines.push(`module inner(d=0) offset(r=clearance+d) polygon(pcb);`, `module outer() offset(r=clearance+wall) polygon(pcb);`, '');
    lines.push(`module base() difference() {`, `  union() {`, `    difference() { linear_extrude(height) outer(); translate([0,0,floor]) linear_extrude(height) inner(); }`,
      `    for (h = concat(holes, supports)) translate([h[0],h[1],floor-0.01]) cylinder(d=standoffDiameter, h=standoff+0.01);`, `  }`,
      `  for (h = holes) translate([h[0],h[1],floor+0.8]) cylinder(d=screwHole, h=standoff);`);
    for (const c of r.cuts) {
      if (c.side === 'lid') continue;
      if (c.side === 'floor') { lines.push(`  // ${c.label || 'floor cutout'}`, c.shape === 'circle' ? `  translate([${f3(c.x)},${f3(c.y)},-1]) cylinder(d=${f3(c.w)}, h=floor+2);` : `  translate([${f3(c.x - c.w / 2)},${f3(c.y - c.h / 2)},-1]) cube([${f3(c.w)},${f3(c.h)},floor+2]);`); continue; }
      const si = sideInfo(L, c.side), depth = P.wall * 2 + P.clearance + 4, zTop = Math.min(c.z + c.h / 2, L.H + 1), zBot = c.z - c.h / 2;
      const cx = si.axis === 'x' ? c.centre : si.wx, cy = si.axis === 'y' ? c.centre : si.wy;
      const sx = si.axis === 'x' ? c.w : depth, sy = si.axis === 'x' ? depth : c.w;
      lines.push(`  // ${c.label || c.side + ' cutout'}`, c.shape === 'circle'
        ? `  translate([${f3(cx)},${f3(cy)},${f3((zTop + zBot) / 2)}]) rotate(${si.axis === 'x' ? '[90,0,0]' : '[0,90,0]'}) cylinder(d=${f3(Math.min(c.w, c.h))}, h=${f3(depth)}, center=true);`
        : `  translate([${f3(cx - sx / 2)},${f3(cy - sy / 2)},${f3(zBot)}]) cube([${f3(sx)},${f3(sy)},${f3(zTop - zBot)}]);`);
    }
    lines.push(`}`, '');
    lines.push(`module lid() difference() {`, `  union() {`, `    translate([0,0,height]) linear_extrude(lidThickness) outer();`,
      `    translate([0,0,height-lipHeight]) linear_extrude(lipHeight+0.01) difference() { offset(delta=-lidFit) inner(); offset(delta=-lidFit-lipWidth) inner(); }`, `  }`);
    for (const c of r.cuts) if (c.side === 'lid') lines.push(`  // ${c.label || 'lid hole'}`, c.shape === 'circle' ? `  translate([${f3(c.x)},${f3(c.y)},height-lipHeight-1]) cylinder(d=${f3(c.w)}, h=lipHeight+lidThickness+2);` : `  translate([${f3(c.x - c.w / 2)},${f3(c.y - c.h / 2)},height-lipHeight-1]) cube([${f3(c.w)},${f3(c.h)},lipHeight+lidThickness+2]);`);
    if (P.vents) lines.push(`  // vents: see the STL (generated slots); add your own here`);
    lines.push(`}`, '', `base();`, `translate([0,0,${f3(P.explode || 12)}]) lid();   // exploded view — print the lid upside down`, '');
    return lines.join('\n');
  }
  function readme(r) {
    const d = describe(r);
    return [`CircuitPilot enclosure — ${Model.S.name || 'board'}`, '', `Outer size: ${d.outer_mm.join(' x ')} mm (base ${d.base_height} mm + lid ${d.lid_thickness} mm)`,
      `PCB sits ${d.pcb_bottom_z} mm above the bed on ${d.supports} ${d.mounting_holes ? 'standoffs (M3 screws, pilot hole ' + r.L.P.screwHole + ' mm)' : 'corner supports'}.`,
      `Cutouts: ${d.cutouts.map(c => c.label || c.side).join(', ') || 'none'}`, '',
      'Print: base as is; lid upside down (already oriented in the STL). 0.2 mm layers, 3 walls, 15-20 % infill; no supports needed for most cutouts.',
      'Fit: the lid lip is lidFit smaller than the cavity — increase lidFit in CircuitPilot if it is too tight.', '',
      'The .scad file is parametric OpenSCAD source of the same design.'].join('\n');
  }
  function describe(r) {
    const L = r ? r.L : layout(), cuts = r ? r.cuts : cutoutList(L), P = L.P;
    return {
      mode: P.mode || 'box', params: P, outer_mm: [+(L.bbox[2] - L.bbox[0]).toFixed(1), +(L.bbox[3] - L.bbox[1]).toFixed(1), +(L.H + P.lidThickness).toFixed(1)],
      base_height: L.H, lid_thickness: P.lidThickness, tallest_part_mm: L.topH, under_board_mm: L.botH, standoff_mm: L.standoff, pcb_bottom_z: +L.pcbZ.toFixed(2),
      mounting_holes: L.holes.length, supports: L.holes.length || supportPoints(L).length,
      cutouts: cuts.map((c, i) => ({ side: c.side, shape: c.shape, w: +(+c.w).toFixed(2), h: +(+c.h).toFixed(2), label: c.label, auto: !!c.auto, index: c.auto ? undefined : P.cutouts.indexOf(P.cutouts.find(q => q.label === c.label && q.side === c.side)) })),
      part_heights: Object.fromEntries(L.parts.map(p => [p.ref, p.h])),
      battery: L.battery ? { id: L.battery.id, name: L.battery.name, mAh: L.battery.mAh, place: L.battery.place, box_mm: [L.battery.x0, L.battery.y0, L.battery.z0, L.battery.x1, L.battery.y1, L.battery.z1].map(v => +v.toFixed(2)) } : null,
    };
  }
  // three.js-friendly flat arrays for the preview
  function meshArrays(polys, tf) {
    const tris = triangles(polys, tf), pos = new Float32Array(tris.length * 9), nor = new Float32Array(tris.length * 9);
    tris.forEach(([a, b, c], i) => {
      let n = b.minus(a).cross(c.minus(a)); const l = n.len(); n = l > 0 ? n.times(1 / l) : n;
      [a, b, c].forEach((v, k) => { pos.set([v.x, v.y, v.z], i * 9 + k * 3); nor.set([n.x, n.y, n.z], i * 9 + k * 3); });
    });
    return { pos, nor, triangles: tris.length };
  }
  // CSG kernel, shared with the script modeller (shape3d.js)
  const csg = { setQuality, get HQ() { return HQ; }, guard, V, Plane, Poly, union, subtract, intersect, repair, zipSeams, fillHoles, earcut, ccw, dedupe, offset, area, triangles, stl, meshArrays };
  return { DEFAULTS, BATTERIES, MODULES, moduleInfo, battery, batteries, setQuality, mode, script, params, setParams, addCutout, layout, build, exportFiles, describe, meshArrays, partHeight, stl, offset, csg };
})();
if (typeof module !== 'undefined') module.exports = Enclosure;
