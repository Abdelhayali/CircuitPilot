// G-code for milling a 1-layer PCB on a desktop CNC (GRBL 1.1: CNC 3018 Pro and the like): V-bit isolation around
// the copper, one drill file per bit size, the outline cut with holding tabs (holes bigger than the end mill are
// milled in the same file). The geometry comes from the design itself, drawn the same way as the copper Gerber —
// pours, their clearances, the edge band and keep-outs included — on a fine grid; the isolation rings are the
// contours of that copper's distance field. X0 Y0 = lower-left corner of the PCB (or of the job), Z0 = copper surface.
const Cnc = (() => {
  const DEF = {
    iso_dia: 0, iso_depth: 0.2, vbit_angle: 30, vbit_tip: 0.1, iso_passes: 2, iso_overlap: 0.3, iso_feed: 120, plunge_feed: 60,
    drill_feed: 40, cut_dia: 2, cut_step: 0.3, cut_feed: 100, tabs: 4, tab_width: 2, tab_height: 0.5,
    spindle: 1000, safe_z: 5, travel_z: 1, origin: 'board', drill_bits: [0.8, 1.0], widen_feed: 30, widen_step: 0.4, mirror: 'auto', board_thick: 0, resolution: 0.02, layer: '',
  };
  const MAX_CELLS = 6e6;
  // local copies: inside the MCP server's vm every global lookup in a hot loop is slow
  const { sqrt, abs, hypot } = Math, INF = Infinity;
  const koOn = (k, layer) => k.layer === 'both' || !k.layer || k.layer === layer;

  // ---------- raster ----------
  function grid(box, g) {
    let [x0, y0, x1, y1] = box;
    if ((x1 - x0) * (y1 - y0) / (g * g) > MAX_CELLS) g = Math.sqrt((x1 - x0) * (y1 - y0) / MAX_CELLS);
    const nx = Math.ceil((x1 - x0) / g) + 1, ny = Math.ceil((y1 - y0) / g) + 1;
    return { x0, y0, g, nx, ny, N: nx * ny };
  }
  // painters on a Uint8Array (value v) — cells are the grid nodes
  function painter(G, M) {
    const { x0, y0, g, nx, ny } = G;
    const span = (a, b, n) => [Math.max(0, Math.floor(a)), Math.min(n - 1, Math.ceil(b))];
    function capsule(ax, ay, bx, by, r, v) {
      const [i0, i1] = span((Math.min(ax, bx) - r - x0) / g, (Math.max(ax, bx) + r - x0) / g, nx);
      const [j0, j1] = span((Math.min(ay, by) - r - y0) / g, (Math.max(ay, by) + r - y0) / g, ny);
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy, r2 = r * r;
      for (let j = j0; j <= j1; j++) {
        const y = y0 + j * g;
        for (let i = i0; i <= i1; i++) {
          const x = x0 + i * g; let t = L2 ? ((x - ax) * dx + (y - ay) * dy) / L2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
          const ex = x - ax - t * dx, ey = y - ay - t * dy;
          if (ex * ex + ey * ey <= r2) M[j * nx + i] = v;
        }
      }
    }
    function rect(cx, cy, w, h, v) {
      const [i0, i1] = span((cx - w / 2 - x0) / g, (cx + w / 2 - x0) / g, nx), [j0, j1] = span((cy - h / 2 - y0) / g, (cy + h / 2 - y0) / g, ny);
      for (let j = j0; j <= j1; j++) { const y = y0 + j * g; if (Math.abs(y - cy) > h / 2) continue; for (let i = i0; i <= i1; i++) if (Math.abs(x0 + i * g - cx) <= w / 2) M[j * nx + i] = v; }
    }
    // even-odd scanline fill of one closed ring
    function poly(pts, v) {
      let ya = Infinity, yb = -Infinity; for (const q of pts) { ya = Math.min(ya, q[1]); yb = Math.max(yb, q[1]); }
      const [j0, j1] = span((ya - y0) / g, (yb - y0) / g, ny), xs = [];
      for (let j = j0; j <= j1; j++) {
        const y = y0 + j * g; xs.length = 0;
        for (let k = 0, n = pts.length; k < n; k++) {
          const a = pts[k], b = pts[(k + 1) % n];
          if ((a[1] <= y) !== (b[1] <= y)) xs.push(a[0] + (y - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
        }
        xs.sort((p, q) => p - q);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const i0 = Math.max(0, Math.ceil((xs[k] - x0) / g)), i1 = Math.min(nx - 1, Math.floor((xs[k + 1] - x0) / g));
          for (let i = i0; i <= i1; i++) M[j * nx + i] = v;
        }
      }
    }
    // a pad as its Gerber aperture (round / oval / rectangle), grown by `grow` on every side
    function pad(p, grow, v) {
      const w = p.w + 2 * grow, h = p.h + 2 * grow;
      if (p.shape === 'round') capsule(p.x, p.y, p.x, p.y, w / 2, v);
      else if (p.shape === 'oval') { const r = Math.min(w, h) / 2, a = Math.max(w, h) / 2 - r; w >= h ? capsule(p.x - a, p.y, p.x + a, p.y, r, v) : capsule(p.x, p.y - a, p.x, p.y + a, r, v); }
      else rect(p.x, p.y, w, h, v);
    }
    return { capsule, rect, poly, pad };
  }
  // exact Euclidean distance transform (Felzenszwalb): in place, squared distance in cells to the nearest 0 cell
  function edt(D, nx, ny) {
    const n = Math.max(nx, ny), f = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1), INF = 1e20;
    const line = (off, stride, len) => {
      v[0] = 0; z[0] = -INF; z[1] = INF; f[0] = D[off];
      for (let q = 1, k = 0, s = 0; q < len; q++) {
        f[q] = D[off + q * stride]; const q2 = q * q;
        do { const r = v[k]; s = (f[q] - f[r] + q2 - r * r) / (q - r) / 2; } while (s <= z[k] && --k > -1);
        k++; v[k] = q; z[k] = s; z[k + 1] = INF;
      }
      for (let q = 0, k = 0; q < len; q++) { while (z[k + 1] < q) k++; const r = v[k], qr = q - r; D[off + q * stride] = f[r] + qr * qr; }
    };
    for (let i = 0; i < nx; i++) line(i, nx, ny);
    for (let j = 0; j < ny; j++) line(j * nx, 1, nx);
    return D;
  }
  // distance (mm) from every node outside `M == val` to that region's edge (nodes inside: −g/2)
  function distance(G, M, val) {
    const N = G.N, g = G.g, h = g / 2, D = new Float32Array(N);
    for (let k = 0; k < N; k++) D[k] = M[k] === val ? 0 : 1e20;
    edt(D, G.nx, G.ny);
    for (let k = 0; k < N; k++) D[k] = M[k] === val ? -h : sqrt(D[k]) * g - h;
    return D;
  }
  // connected regions (4-neighbour) of the nodes where in(k) is true; labels from 1
  function label(G, inside) {
    const L = new Int32Array(G.N), st = new Int32Array(G.N), { nx, ny } = G; let n = 0;
    for (let s = 0; s < G.N; s++) {
      if (L[s] || !inside(s)) continue;
      n++; let sp = 0; st[sp++] = s; L[s] = n;
      while (sp) {
        const k = st[--sp], i = k % nx;
        if (i > 0 && !L[k - 1] && inside(k - 1)) { L[k - 1] = n; st[sp++] = k - 1; }
        if (i < nx - 1 && !L[k + 1] && inside(k + 1)) { L[k + 1] = n; st[sp++] = k + 1; }
        if (k >= nx && !L[k - nx] && inside(k - nx)) { L[k - nx] = n; st[sp++] = k - nx; }
        if (k < (ny - 1) * nx && !L[k + nx] && inside(k + nx)) { L[k + nx] = n; st[sp++] = k + nx; }
      }
    }
    return { L, n };
  }

  // ---------- contours (marching squares, oriented: the region F < 0 always on the same side) ----------
  function contours(G, F) {
    const { nx, ny, x0, y0, g } = G, next = new Map();
    // the grid's border is outside, so every contour closes (F is scratch: changed in place)
    for (let i = 0; i < nx; i++) { F[i] = 1; F[(ny - 1) * nx + i] = 1; }
    for (let j = 0; j < ny; j++) { F[j * nx] = 1; F[j * nx + nx - 1] = 1; }
    const e = [0, 0, 0, 0], tp = [0, 0, 0, 0], val = [0, 0, 0, 0];
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const k = j * nx + i, a = F[k], b = F[k + 1], c2 = F[k + 1 + nx], d = F[k + nx];
      if ((a < 0) === (b < 0) && (a < 0) === (c2 < 0) && (a < 0) === (d < 0)) continue;
      val[0] = a; val[1] = b; val[2] = c2; val[3] = d;
      // cell sides in turn (v0→v1, v1→v2, v2→v3, v3→v0): 'A' leaves the region, 'B' enters it
      const ids = [2 * k, 2 * (k + 1) + 1, 2 * (k + nx), 2 * k + 1]; let m = 0;
      for (let s = 0; s < 4; s++) { const a = val[s] < 0, b = val[(s + 1) & 3] < 0; if (a !== b) { e[m] = ids[s]; tp[m] = a ? 1 : 0; m++; } }
      if (m === 2) { tp[0] ? next.set(e[0], e[1]) : next.set(e[1], e[0]); continue; }
      // saddle: the centre decides whether the region joins across the cell
      const join = (val[0] + val[1] + val[2] + val[3]) / 4 < 0;
      for (let s = 0; s < 4; s++) if (tp[s]) next.set(e[s], e[join ? (s + 1) & 3 : (s + 3) & 3]);
    }
    const P = id => {
      const k = id >> 1, i = k % nx, j = (k - i) / nx, b = id & 1 ? k + nx : k + 1, fa = F[k], fb = F[b], t = fa / (fa - fb);
      return id & 1 ? [x0 + i * g, y0 + (j + t) * g] : [x0 + (i + t) * g, y0 + j * g];
    };
    const loops = [];
    for (const start of next.keys()) {
      if (!next.has(start)) continue;
      const pts = []; let id = start;
      while (next.has(id)) { pts.push(P(id)); const n = next.get(id); next.delete(id); id = n; }
      if (pts.length >= 3) loops.push(pts);
    }
    return loops;
  }
  const area = pts => { let a = 0; for (let i = 0, n = pts.length; i < n; i++) { const p = pts[i], q = pts[(i + 1) % n]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
  // Douglas–Peucker on a closed ring
  function simplify(pts, tol) {
    if (pts.length < 8) return pts;
    let far = 0, best = -1; for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]); if (d > best) { best = d; far = i; } }
    const keep = new Uint8Array(pts.length); keep[0] = keep[far] = 1;
    const st = [[0, far], [far, pts.length]];
    while (st.length) {
      const [a, b] = st.pop(), A = pts[a], B = pts[b % pts.length], dx = B[0] - A[0], dy = B[1] - A[1], L = Math.hypot(dx, dy) || 1e-12;
      let m = -1, dm = tol;
      for (let i = a + 1; i < b; i++) { const d = abs((pts[i][0] - A[0]) * dy - (pts[i][1] - A[1]) * dx) / L; if (d > dm) { dm = d; m = i; } }
      if (m >= 0) { keep[m] = 1; st.push([a, m], [m, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  }

  // ---------- G-code text ----------
  const n3 = v => { const s = (Math.abs(v) < 5e-4 ? 0 : v).toFixed(3).replace(/\.?0+$/, ''); return s === '-0' ? '0' : s; };
  const ascii = s => String(s).replace(/[^\x20-\x7e]/g, '?').replace(/[()]/g, '');
  function gfile(title, o, lines) {
    return [`(CircuitPilot CNC - ${ascii(title)})`, `(X0 Y0 = lower-left corner of the ${o.origin === 'job' ? 'job' : 'PCB'}, Z0 = copper surface, mm)`,
      'G21 G90 G94', `G0 Z${n3(o.safe_z)}`, `M3 S${o.spindle}`, 'G4 P3', ...lines,
      `G0 Z${n3(o.safe_z)}`, 'M5', 'G0 X0 Y0', 'M2', ''].join('\n');
  }
  const len = pts => { let s = 0; for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return s; };

  // ---------- the job ----------
  function job(opts = {}) {
    const o = { ...DEF }; for (const k in opts) if (opts[k] !== undefined && opts[k] !== null && opts[k] !== '') o[k] = opts[k];
    for (const k of Object.keys(DEF)) if (typeof DEF[k] === 'number') o[k] = +o[k];
    const S = Model.S, R = Pcb.rules(), cs = Pcb.placed(), idx = Model.pinIndex();
    if (!cs.length || !S.board.w) throw new Error('No PCB yet — generate_pcb first');
    // the groove the V-bit cuts at that depth (iso_dia 0 = from the bit: tip + 2 · depth · tan(angle / 2))
    if (!(o.iso_dia > 0)) o.iso_dia = +(o.vbit_tip + 2 * o.iso_depth * Math.tan(o.vbit_angle / 2 * Math.PI / 180)).toFixed(3);
    if (!(o.iso_dia > 0 && o.iso_depth > 0 && o.cut_dia > 0 && o.cut_step > 0)) throw new Error('iso_dia (or vbit_tip / vbit_angle), iso_depth, cut_dia and cut_step must be > 0');
    const warnings = [], pads = cs.flatMap(c => Pcb.padsOf(c, idx)), traces = S.pcb.traces || [];
    // the copper side to mill: the one with the tracks (through-hole pads are on both)
    const tl = new Set(traces.map(t => t.layer));
    let layer = o.layer === 'F' || o.layer === 'B' ? o.layer : null;
    if (!layer) {
      if (tl.size > 1) throw new Error('Tracks on both copper layers: a milled board has one copper side. Re-route on one layer (set_design_rules {preset: "home"} → route_pcb), or replace the bottom tracks with wire jumpers; layer: "F" / "B" mills one side only');
      layer = tl.size ? [...tl][0] : pads.some(p => !p.drill && p.layer === 'B') ? 'B' : 'F';
    } else if (tl.size > 1) warnings.push(`Tracks on both layers — only the ${layer === 'F' ? 'top' : 'bottom'} copper is milled; the other side's tracks need wire jumpers`);
    const smd = pads.filter(p => !p.drill && p.layer === layer), tht = pads.filter(p => p.drill);
    if ((S.pcb.vias || []).length) warnings.push(`${S.pcb.vias.length} via${S.pcb.vias.length > 1 ? 's are' : ' is'} drilled; on a 1-sided board each needs a wire link on the other side (or remove them)`);
    // mirror: copper facing up on the machine, seen from below when the parts go on the other side
    // where the parts go decides the mirror: parts_side "bare" (through-hole parts in from the side without copper) =
    // mirrored, "copper" (parts on the copper) = not mirrored; mirror on / off says the same; auto picks from the parts
    const side = String(o.parts_side || '').toLowerCase();
    let mirror = side === 'bare' ? true : side === 'copper' ? false : o.mirror === true || o.mirror === 'on' || o.mirror === 'true' ? true : o.mirror === false || o.mirror === 'off' || o.mirror === 'false' ? false : null;
    const chosen = mirror !== null;
    // mixed boards: the through-hole parts go in from the bare side, the SMD parts sit on the copper — mirrored, as long as
    // every SMD part there is a 2-pad part (a mirrored 1206 is the same part; a mirrored SOIC has its pins reversed)
    const smdPins = new Map(); for (const p of smd) smdPins.set(p.ref, (smdPins.get(p.ref) || 0) + 1);
    const symmetric = [...smdPins.values()].every(n => n <= 2);
    if (mirror === null) mirror = layer === 'B' || !smd.length || (tht.length > 0 && symmetric);
    if (layer === 'F' && smd.length && tht.length) warnings.push(mirror
      ? 'Mirrored: through-hole parts go in from the bare side (soldered on the copper), the 2-pad SMD parts are soldered on the copper side'
      : `Not mirrored: ${[...smdPins].filter(([, n]) => n > 2).map(([r]) => r).slice(0, 4).join(', ')} would have reversed pins on the copper side, so the through-hole parts sit on the copper side too (leads not through the board)`);
    const thick = o.board_thick > 0 ? o.board_thick : Pcb.boardThickness();
    if (!R.cnc) warnings.push('Design rules are not "CNC milling - 3018" (set_design_rules {preset: "cnc3018"}, or Rules in the PCB tab): tracks, gaps and rings may be too fine to mill safely');
    if (R.clearance < o.iso_dia + 0.05) warnings.push(`Design clearance ${R.clearance} mm is under the V-bit cut (${o.iso_dia} mm) + 0.05: copper that close is not separated — a shallower cut, a finer V-bit or wider clearance (set_design_rules {preset: "cnc3018"}: 0.4 mm)`);

    // ---- raster of the copper (same order as the Gerber: pours, their clearances, then all copper) ----
    const outline = Pcb.boardPoly(), bx0 = Math.min(...outline.map(q => q[0])), bx1 = Math.max(...outline.map(q => q[0])), by0 = Math.min(...outline.map(q => q[1])), by1 = Math.max(...outline.map(q => q[1]));
    const W = bx1 - bx0, H = by1 - by0, mg = o.cut_dia + 1;
    const G = grid([bx0 - mg, by0 - mg, bx1 + mg, by1 + mg], o.resolution > 0 ? o.resolution : DEF.resolution), g = G.g;
    const Cu = new Uint8Array(G.N), pc = painter(G, Cu);
    const onL = p => p.drill || (p.layer || 'F') === layer;
    const copper = (grow, skip, v) => {
      for (const t of traces) if (t.layer === layer && (skip === undefined || t.net !== skip)) for (let i = 1; i < t.pts.length; i++) pc.capsule(...t.pts[i - 1], ...t.pts[i], t.w / 2 + grow, v);
      for (const t of traces) if (t.layer === layer && t.pts.length === 1 && (skip === undefined || t.net !== skip)) pc.capsule(...t.pts[0], ...t.pts[0], t.w / 2 + grow, v);
      for (const p of pads) if (onL(p) && (skip === undefined || p.net !== skip)) pc.pad(p, grow, v);
      for (const q of S.pcb.vias || []) if (skip === undefined || q.net !== skip) pc.capsule(q.x, q.y, q.x, q.y, q.d / 2 + grow, v);
      if (skip !== undefined) for (const h of S.pcb.holes || []) pc.capsule(h.x, h.y, h.x, h.y, h.d / 2 + grow, v);
    };
    for (const pr of (S.pcb.pours || []).filter(pr => pr.layer === layer && S.nets[pr.net])) {
      const cl = Pcb.pourCl(R, pr);
      for (const rg of Pcb.pourFill(pr).rings) pc.poly(rg.pts, rg.hole ? 0 : 1);
      copper(cl, pr.net, 0);
      for (let i = 0; i < outline.length; i++) pc.capsule(...outline[i], ...outline[(i + 1) % outline.length], R.edgeClearance, 0);
      for (const k of Pcb.pourKeepouts(layer)) pc.poly(k.pts, 0);
    }
    copper(0, undefined, 1);
    const Bd = new Uint8Array(G.N); painter(G, Bd).poly(outline, 1);

    // ---- milling frame: lower-left of the board at 0,0, Y up, mirrored about the board centre, job origin ----
    const off = o.origin === 'board' ? 0 : o.cut_dia;
    const T = q => [(mirror ? bx1 - q[0] : q[0] - bx0) + off, by1 - q[1] + off];
    // every path keeps its material on the left (conventional milling with M3)
    const frame = loops => loops.map(l => { const p = l.map(T); if (!mirror) p.reverse(); return p; });
    const tol = Math.max(0.003, g / 2);

    // ---- isolation: rings at iso/2, iso/2 + step … around the copper, inside the board (0.05 mm in) ----
    const Dc = distance(G, Cu, 1), Din = distance(G, Bd, 0), F = new Float32Array(G.N), passes = [], rawPasses = [];
    for (let k = 0; k < Math.max(1, Math.round(o.iso_passes)); k++) {
      const r = o.iso_dia / 2 + k * o.iso_dia * (1 - o.iso_overlap);
      for (let q = 0; q < G.N; q++) { const a = Dc[q] - r, b = Bd[q] ? 0.05 - Din[q] : 1; F[q] = a > b ? a : b; }
      const raw = contours(G, F).filter(l => Math.abs(area(l)) > g * g * 4).map(l => simplify(l, tol));
      rawPasses.push(raw); passes.push(frame(raw));
    }
    const node = (x, y) => { const i = Math.round((x - G.x0) / g), j = Math.round((y - G.y0) / g); return i < 0 || j < 0 || i >= G.nx || j >= G.ny ? -1 : j * G.nx + i; };
    // ---- copper cleared away where the pour stays out: under SMD parts (no strip between the pads of a 1206 to
    // bridge with solder) and in keep-outs (antenna end). Milling only cuts grooves, so without this the copper there
    // would stay as a floating island. Zig-zag lines across the area, clear of all copper by half the groove ----
    const clearRaw = [], step = o.iso_dia * (1 - o.iso_overlap), keep = o.iso_dia / 2 + 0.02;
    for (const k of Pcb.pourKeepouts(layer)) {
      const xs = k.pts.map(q => q[0]), ys = k.pts.map(q => q[1]), kx0 = Math.min(...xs), kx1 = Math.max(...xs);
      let flip = false;
      for (let y = Math.min(...ys) + step / 2; y < Math.max(...ys); y += step) {
        const runs = []; let a = null;
        for (let x = kx0; x <= kx1 + 1e-9; x += g) {
          const q = node(x, y), ok = q >= 0 && Pcb.inPoly(x, y, k.pts) && Bd[q] && Din[q] > 0.05 && Dc[q] > keep;
          if (ok && a === null) a = x; if (!ok && a !== null) { if (x - g - a > 0.05) runs.push([a, x - g]); a = null; }
        }
        if (a !== null && kx1 - a > 0.05) runs.push([a, kx1]);
        if (flip) runs.reverse();
        for (const [x0, x1] of runs) clearRaw.push(flip ? [[x1, y], [x0, y]] : [[x0, y], [x1, y]]);
        flip = !flip;
      }
    }
    const clearPaths = clearRaw.map(l => l.map(T));
    // copper the V-bit cannot separate: two nets inside one ring
    const cuL = label(G, k => Cu[k] === 1), grownL = label(G, k => Dc[k] <= o.iso_dia / 2), netOf = new Map();
    const tag = (x, y, net) => { const k = node(x, y); if (k >= 0 && net && cuL.L[k]) { const gk = grownL.L[k]; if (!netOf.has(gk)) netOf.set(gk, new Set()); netOf.get(gk).add(net); } };
    for (const p of pads) if (onL(p)) tag(p.x, p.y, p.net);
    for (const t of traces) if (t.layer === layer) for (const q of t.pts) tag(q[0], q[1], t.net);
    for (const s of netOf.values()) if (s.size > 1) warnings.push(`${[...s].slice(0, 4).join(' / ')}${s.size > 4 ? ' …' : ''}: copper closer than the ${o.iso_dia} mm V-bit — they stay shorted (wider clearance, a finer bit or a smaller iso_dia)`);
    // check of the toolpaths themselves: the whole sheet is copper except where the grooves go. A narrower groove than
    // planned (a shallow spot) must still separate every net, a wider one (a worn bit, a low spot) must not cut a net in two
    const verify = width => {
      const M = Bd.slice(), pm = painter(G, M);
      for (const loops of rawPasses) for (const l of loops) for (let i = 0; i < l.length; i++) pm.capsule(...l[i], ...l[(i + 1) % l.length], width / 2, 0);
      for (const l of clearRaw) pm.capsule(...l[0], ...l[1], width / 2, 0);
      const lab = label(G, k => M[k] === 1).L, byLab = new Map(), byNet = new Map();
      const put = (x, y, net) => { const k = node(x, y); if (k < 0 || !net || !lab[k]) return; if (!byLab.has(lab[k])) byLab.set(lab[k], new Set()); byLab.get(lab[k]).add(net); if (!byNet.has(net)) byNet.set(net, new Set()); byNet.get(net).add(lab[k]); };
      for (const p of pads) if (onL(p)) put(p.x, p.y, p.net);
      for (const t of traces) if (t.layer === layer) for (const q of t.pts) put(q[0], q[1], t.net);
      return { shorts: [...byLab.values()].filter(s => s.size > 1).map(s => [...s]), opens: [...byNet].filter(([, s]) => s.size > 1).map(([n]) => n) };
    };
    const narrow = +(o.iso_dia * 0.6).toFixed(3), wideG = +(o.iso_dia * 1.5).toFixed(3), vN = verify(narrow), vW = verify(wideG);
    for (const s of vN.shorts) warnings.push(`Toolpath check: with a ${narrow} mm groove (a shallow spot) ${s.slice(0, 4).join(' / ')} stay connected`);
    if (vW.opens.length) warnings.push(`Toolpath check: with a ${wideG} mm groove (worn bit, low spot) ${vW.opens.slice(0, 6).join(', ')} would be cut in two — wider tracks`);
    const verified = { shorts_at_narrow_groove: vN.shorts.length, nets_cut_at_wide_groove: vW.opens.length, narrow_mm: narrow, wide_mm: wideG };

    // ---- holes: drilled per bit size; bigger than the end mill → milled in the cutout file ----
    const holes = [...tht.map(p => ({ x: p.x, y: p.y, d: p.drill })), ...(S.pcb.vias || []).map(v => ({ x: v.x, y: v.y, d: v.drill })), ...(S.pcb.holes || []).map(h => ({ x: h.x, y: h.y, d: h.d }))]
      .map(h => ({ d: +h.d.toFixed(2), p: T([h.x, h.y]) }));
    const millAt = o.cut_dia + 0.1, drilled = holes.filter(h => h.d < millAt), milled = holes.filter(h => h.d >= millAt);
    // each hole gets the smallest bit that is not too small (0.05 mm tolerance); bigger than every bit → drilled with the
    // biggest, then widened with it in a small circle, in steps
    let bitSet = (Array.isArray(o.drill_bits) ? o.drill_bits : String(o.drill_bits).split(/[\s,;]+/)).map(Number).filter(b => b > 0).sort((a, b) => a - b);
    if (!bitSet.length) bitSet = DEF.drill_bits.slice();
    for (const h of drilled) { const b = bitSet.find(q => q >= h.d - 0.05); h.bit = b || bitSet[bitSet.length - 1]; h.widen = !b; }
    const up = drilled.filter(h => h.bit > h.d + 0.05), wide = drilled.filter(h => h.widen);
    if (up.length) warnings.push(`${up.length} hole${up.length > 1 ? 's' : ''} of ${[...new Set(up.map(h => h.d))].join(' / ')} mm drilled at ${[...new Set(up.map(h => h.bit))].join(' / ')} mm (no smaller bit)`);
    if (wide.length) warnings.push(`${wide.length} hole${wide.length > 1 ? 's' : ''} of ${[...new Set(wide.map(h => h.d))].join(' / ')} mm: drilled with the ${bitSet[bitSet.length - 1]} mm bit, then widened in a small circle (slow, ${o.widen_feed} mm/min). If the bit chatters, stop and widen those by hand`);
    const order = (pts, from = [0, 0]) => { const left = pts.slice(), out = []; let c = from; while (left.length) { let b = 0, bd = Infinity; left.forEach((h, i) => { const d = Math.hypot(h.p[0] - c[0], h.p[1] - c[1]); if (d < bd) { bd = d; b = i; } }); c = left[b].p; out.push(left.splice(b, 1)[0]); } return out; };

    // ---- outline: the end mill's centre path, cut_dia/2 outside the board ----
    const Dout = distance(G, Bd, 1);
    // exact near the cutter path: the distance to the outline's own edges (the grid alone is off by up to g/2)
    F.fill(INF);
    for (let e = 0, n = outline.length, r = o.cut_dia / 2 + 3 * g; e < n; e++) {
      const [ax, ay] = outline[e], [bx, by] = outline[(e + 1) % n], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-12;
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - r - G.x0) / g)), i1 = Math.min(G.nx - 1, Math.ceil((Math.max(ax, bx) + r - G.x0) / g));
      const j0 = Math.max(0, Math.floor((Math.min(ay, by) - r - G.y0) / g)), j1 = Math.min(G.ny - 1, Math.ceil((Math.max(ay, by) + r - G.y0) / g));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const x = G.x0 + i * g - ax, y = G.y0 + j * g - ay; let t = (x * dx + y * dy) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = x - t * dx, ey = y - t * dy, d = sqrt(ex * ex + ey * ey), k = j * G.nx + i; if (d < F[k]) F[k] = d;
      }
    }
    for (let q = 0; q < G.N; q++) if (F[q] !== INF) Dout[q] = Bd[q] ? -F[q] : F[q];
    for (let q = 0; q < G.N; q++) F[q] = Dout[q] - o.cut_dia / 2;
    const cutLoops = frame(contours(G, F).map(l => simplify(l, tol))).sort((a, b) => Math.abs(area(b)) - Math.abs(area(a)));
    if (!cutLoops.length) throw new Error('Board outline not found');
    let cut = cutLoops[0];
    // start on the left end of the bottom edge (a straight run, away from the tabs)
    let si = 0; cut.forEach((q, i) => { if (q[1] < cut[si][1] - 1e-6 || (Math.abs(q[1] - cut[si][1]) < 1e-6 && q[0] < cut[si][0])) si = i; });
    cut = cut.slice(si).concat(cut.slice(0, si));

    // ---- files ----
    const files = {}, name = S.name || 'board', fz = o.iso_feed, info = { drills: [] };
    // 1: isolation, pass by pass, the nearest ring next (starting at its nearest point)
    let pos = [0, 0], isoLen = 0, rings = 0;
    const iso = [];
    passes.forEach((loops, k) => {
      const left = loops.slice();
      if (left.length) iso.push(`(isolation pass ${k + 1} of ${passes.length})`);
      while (left.length) {
        let bi = 0, bj = 0, bd = Infinity;
        left.forEach((l, i) => l.forEach((q, j) => { const d = (q[0] - pos[0]) ** 2 + (q[1] - pos[1]) ** 2; if (d < bd) { bd = d; bi = i; bj = j; } }));
        const l = left.splice(bi, 1)[0], p = l.slice(bj).concat(l.slice(0, bj + 1));
        iso.push(`G0 Z${n3(o.safe_z)}`, `G0 X${n3(p[0][0])} Y${n3(p[0][1])}`, `G0 Z${n3(o.travel_z)}`, `G1 Z${n3(-o.iso_depth)} F${o.plunge_feed}`, `G1 X${n3(p[1][0])} Y${n3(p[1][1])} F${fz}`);
        for (const q of p.slice(2)) iso.push(`X${n3(q[0])} Y${n3(q[1])}`);
        isoLen += len(p); rings++; pos = p[p.length - 1];
      }
    });
    if (clearPaths.length) iso.push(`(clearing: no copper under SMD parts and in keep-outs, ${clearPaths.length} lines)`, `G0 Z${n3(o.safe_z)}`);
    for (const p of clearPaths) {
      iso.push(`G0 X${n3(p[0][0])} Y${n3(p[0][1])}`, `G0 Z${n3(o.travel_z)}`, `G1 Z${n3(-o.iso_depth)} F${o.plunge_feed}`, `G1 X${n3(p[1][0])} Y${n3(p[1][1])} F${fz}`, `G0 Z${n3(o.travel_z)}`);
      isoLen += len(p);
    }
    files['1_isolation.nc'] = gfile(`${name} - isolation, V-bit ${o.iso_dia} mm at ${o.iso_depth} mm deep, ${passes.length} pass${passes.length > 1 ? 'es' : ''}`, o, iso);
    // 2: one file per drill size
    const sizes = [...new Set(drilled.map(h => h.bit))].sort((a, b) => a - b), dz = -(thick + 0.2);
    const wz = Array.from({ length: Math.max(1, Math.ceil(-dz / o.widen_step - 1e-9)) }, (_, i) => -Math.min(-dz, (i + 1) * o.widen_step));
    for (const d of sizes) {
      const hs = order(drilled.filter(h => h.bit === d)), L = [];
      for (const h of hs) L.push(`G0 X${n3(h.p[0])} Y${n3(h.p[1])}`, `G0 Z${n3(o.travel_z)}`, `G1 Z${n3(dz)} F${o.drill_feed}`, `G0 Z${n3(o.travel_z)}`);
      // widened holes: a circle of the missing radius, a step deeper each turn
      for (const h of hs.filter(q => q.widen)) {
        const r = (h.d - d) / 2, sx = h.p[0] + r;
        L.push(`(widen to ${h.d} mm)`, `G0 X${n3(sx)} Y${n3(h.p[1])}`);
        for (const z of wz) L.push(`G1 Z${n3(z)} F${o.drill_feed}`, `G2 X${n3(sx)} Y${n3(h.p[1])} I${n3(-r)} J0 F${o.widen_feed}`);
        L.push(`G0 Z${n3(o.travel_z)}`);
      }
      const nw = hs.filter(q => q.widen).length, fn = `2_drill_${d.toFixed(2)}mm.nc`;
      files[fn] = gfile(`${name} - drill ${d.toFixed(2)} mm, ${hs.length} hole${hs.length > 1 ? 's' : ''}${nw ? ` (${nw} widened)` : ''}, ${n3(-dz)} mm deep`, o, L);
      info.drills.push({ file: fn, bit_mm: d, holes: hs.length, widened: nw || undefined });
    }
    // 3: big holes (helix), then the outline with tabs, step by step down to the board thickness + 0.1
    const total = thick + 0.1, steps = Math.max(1, Math.ceil(total / o.cut_step - 1e-9)), tabTop = -(total - o.tab_height), C = [];
    const zs = Array.from({ length: steps }, (_, i) => -Math.min(total, (i + 1) * o.cut_step));
    for (const h of order(milled)) {
      const r = (h.d - o.cut_dia) / 2, sx = h.p[0] + r, sy = h.p[1];
      C.push(`(hole ${h.d} mm)`, `G0 Z${n3(o.safe_z)}`, `G0 X${n3(sx)} Y${n3(sy)}`, `G0 Z${n3(o.travel_z)}`);
      for (const z of zs) C.push(`G1 Z${n3(z)} F${o.plunge_feed}`, `G2 X${n3(sx)} Y${n3(sy)} I${n3(-r)} J0 F${o.cut_feed}`);
    }
    const ring = cut.concat([cut[0]]), s = [0]; for (let i = 1; i < ring.length; i++) s.push(s[i - 1] + Math.hypot(ring[i][0] - ring[i - 1][0], ring[i][1] - ring[i - 1][1]));
    const Lc = s[s.length - 1];
    let nt = Math.max(0, Math.round(o.tabs)), hw = (o.tab_width + o.cut_dia) / 2;
    while (nt && Lc / nt < 2 * hw + 4) nt--;
    const tabs = Array.from({ length: nt }, (_, t) => [Lc * (t + 0.5) / nt - hw, Lc * (t + 0.5) / nt + hw]);
    const inTab = d => tabs.some(([a, b]) => d > a && d < b);
    C.push('(outline)', `G0 Z${n3(o.safe_z)}`, `G0 X${n3(ring[0][0])} Y${n3(ring[0][1])}`, `G0 Z${n3(o.travel_z)}`);
    for (const z of zs) {
      C.push(`G1 Z${n3(z)} F${o.plunge_feed}`, `F${o.cut_feed}`);
      const lift = nt && z < tabTop - 1e-9;
      for (let i = 1; i < ring.length; i++) {
        if (lift) {
          // the tab edges on this segment, in order: up over the tab, down after it
          const cuts = tabs.flat().filter(d => d > s[i - 1] && d < s[i]).sort((a, b) => a - b);
          for (const d of cuts) {
            const t = (d - s[i - 1]) / (s[i] - s[i - 1]), x = ring[i - 1][0] + t * (ring[i][0] - ring[i - 1][0]), y = ring[i - 1][1] + t * (ring[i][1] - ring[i - 1][1]);
            C.push(`G1 X${n3(x)} Y${n3(y)}`, `G1 Z${n3(inTab(d + 1e-6) ? tabTop : z)}`);
          }
        }
        C.push(`G1 X${n3(ring[i][0])} Y${n3(ring[i][1])}`);
      }
    }
    files['3_cutout.nc'] = gfile(`${name} - ${milled.length ? 'holes over ' + n3(millAt) + ' mm and ' : ''}outline, end mill ${o.cut_dia} mm, ${steps} passes of ${o.cut_step} mm, ${nt} tabs`, o, C);

    // ---- preview + notes ----
    const jw = W + 2 * o.cut_dia, jh = H + 2 * o.cut_dia, x0 = off - o.cut_dia, top = off + H + o.cut_dia, pad = 2, vb = [x0 - pad, -pad, jw + 2 * pad, jh + 2 * pad];
    const sy = y => top - y, d = l => 'M' + l.map(q => `${q[0].toFixed(3)} ${sy(q[1]).toFixed(3)}`).join('L') + 'Z';
    const svg = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.join(' ')}" width="${(vb[2] * 8).toFixed(0)}" height="${(vb[3] * 8).toFixed(0)}">`,
      `<rect x="${vb[0]}" y="${-pad}" width="${vb[2]}" height="${vb[3]}" fill="#1b1d22"/>`,
      `<rect x="${x0}" y="0" width="${jw.toFixed(3)}" height="${jh.toFixed(3)}" fill="none" stroke="#555" stroke-width="0.1" stroke-dasharray="0.6 0.4"/>`,
      `<path d="${d(outline.map(T))}" fill="#b87333"/>`,
      ...passes.map((ls, k) => `<path d="${ls.map(d).join('')}" fill="none" stroke="${k ? '#7fb3ff' : '#2f7fff'}" stroke-width="${o.iso_dia}" stroke-linejoin="round" opacity="0.95"/>`),
      clearPaths.length ? `<path d="${clearPaths.map(l => 'M' + l.map(q => `${q[0].toFixed(3)} ${sy(q[1]).toFixed(3)}`).join('L')).join('')}" fill="none" stroke="#2f7fff" stroke-width="${o.iso_dia}" stroke-linecap="round" opacity="0.95"/>` : '',
      `<path d="${d(cut)}" fill="none" stroke="#e5484d" stroke-width="${o.cut_dia}" opacity="0.35"/>`,
      ...tabs.map(([a, b]) => { const m = (a + b) / 2; let i = s.findIndex(v => v >= m); i = Math.max(1, i); const t = (m - s[i - 1]) / ((s[i] - s[i - 1]) || 1), x = ring[i - 1][0] + t * (ring[i][0] - ring[i - 1][0]), y = ring[i - 1][1] + t * (ring[i][1] - ring[i - 1][1]); return `<circle cx="${x.toFixed(3)}" cy="${sy(y).toFixed(3)}" r="${(o.tab_width / 2).toFixed(2)}" fill="#ffd166"/>`; }),
      ...holes.map(h => `<circle cx="${h.p[0].toFixed(3)}" cy="${sy(h.p[1]).toFixed(3)}" r="${(h.d / 2).toFixed(3)}" fill="#111"/>`),
      `<circle cx="0" cy="${top.toFixed(3)}" r="0.6" fill="#3ddc84"/><text x="0.9" y="${(top - 0.6).toFixed(3)}" font-size="1.6" fill="#3ddc84" font-family="sans-serif">X0 Y0</text>`,
      '</svg>'];
    files['preview.svg'] = svg.join('\n') + '\n';
    const mins = (isoLen / fz + passes.flat().length * (o.iso_depth / o.plunge_feed) + Lc * steps / o.cut_feed + drilled.length * (thick + 0.2) / o.drill_feed * 2 + wide.reduce((a, h) => a + Math.PI * (h.d - h.bit) * wz.length / o.widen_feed, 0) + milled.reduce((a, h) => a + Math.PI * (h.d - o.cut_dia) * steps / o.cut_feed, 0)) * 1.15;
    const fl = Object.keys(files).filter(f => f.endsWith('.nc'));
    Object.assign(info, {
      layer: layer === 'F' ? 'top' : 'bottom', mirrored: mirror, parts_side: mirror ? 'bare side (copper on the bottom of the finished board)' : 'copper side', mirror_choice: chosen ? 'chosen' : 'auto — pass parts_side "bare" or "copper" to choose', board_mm: [+W.toFixed(2), +H.toFixed(2)], job_mm: [+jw.toFixed(2), +jh.toFixed(2)],
      origin: o.origin === 'job' ? 'X0 Y0 = lower-left corner of the job: every move is at X ≥ 0, Y ≥ 0' : `X0 Y0 = lower-left corner of the PCB; the cutout reaches ${o.cut_dia} mm left of and below it`,
      isolation: { passes: passes.length, rings, cleared_lines: clearPaths.length, length_mm: Math.round(isoLen), v_bit_mm: o.iso_dia, depth_mm: o.iso_depth, v_bit: `${o.vbit_angle} deg, tip ${o.vbit_tip} mm` }, toolpath_check: verified,
      milled_holes: milled.length, cutout: { end_mill_mm: o.cut_dia, depth_mm: +total.toFixed(2), passes: steps, tabs: nt },
      board_thickness_mm: thick, est_minutes: Math.ceil(mins), files: fl, warnings, grid_mm: +g.toFixed(4),
    });
    const bitList = [`V-bit ${o.vbit_angle} deg, tip ${o.vbit_tip} mm: ${o.iso_dia} mm wide at ${o.iso_depth} mm deep  ->  1_isolation.nc`, ...info.drills.map(q => `${q.bit_mm.toFixed(2)} mm drill (${q.holes} holes${q.widened ? `, ${q.widened} widened` : ''})  ->  ${q.file}`), `${o.cut_dia} mm flat end mill  ->  3_cutout.nc${milled.length ? ` (also mills the ${milled.length} hole${milled.length > 1 ? 's' : ''} of ${n3(millAt)} mm and more)` : ''}`];
    files['README-cnc.txt'] = [`${name} - CNC milling files (GRBL, e.g. CNC 3018 Pro)`, '',
      o.origin === 'job' ? `Board ${info.board_mm.join(' x ')} mm, job ${info.job_mm.join(' x ')} mm (the copper sheet must reach this far right and up from X0 Y0).`
        : `Board ${info.board_mm.join(' x ')} mm. From X0 Y0 the copper sheet must reach ${n3(W + o.cut_dia + 1)} mm right and ${n3(H + o.cut_dia + 1)} mm up, and ${n3(o.cut_dia + 1)} mm left and down (cutout).`,
      `Copper milled: ${info.layer} layer, ${mirror ? 'MIRRORED (copper side up on the machine, parts go on the other side)' : 'not mirrored (parts on the copper side)'}.`,
      `${info.origin}. Z0 = copper surface. About ${info.est_minutes} min of cutting.`, '',
      'Bits and files, in this order (change the bit, set ONLY Z0 again, never X0 / Y0):', ...bitList.map((b, i) => `  ${i + 1}. ${b}`), '',
      'Setup:',
      '  1. Double-sided tape over the whole back of the copper board, on a flat sacrificial board, edges along X / Y, clamps outside the job.',
      o.origin === 'job' ? '  2. Jog the V-bit to the lower-left corner of the copper sheet (1-2 mm inside the edge): X0, Y0.'
        : `  2. Jog the V-bit to where the PCB's lower-left corner goes, at least ${n3(o.cut_dia + 1)} mm in from the sheet's left and bottom edges: X0, Y0.`,
      '  3. Z0: paper between bit and copper, step down 0.01 mm until it drags, take the paper away, 0.01 mm more, Z0.',
      '  4. First time: set Z0 5 mm higher and run 1_isolation.nc in the air to check the moves.',
      '  5. Not flat? Candle -> Heightmap with a probe clip (the files have no height compensation).',
      '  6. Copper strands left between tracks: iso_depth +0.02. Tracks too thin: shallower, or a finer V-bit.', '',
      'Open preview.svg to see the cuts: blue = isolation, red = cutout, yellow = tabs, green = X0 Y0.',
      ...(warnings.length ? ['', 'WARNINGS:', ...warnings.map(w => '  - ' + w)] : []), ''].join('\n');
    return { files, info };
  }
  return { job, DEF };
})();
