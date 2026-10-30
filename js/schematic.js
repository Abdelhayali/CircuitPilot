'use strict';
// Schematic renderer + editor (select, drag, rotate, click pin-to-pin to wire).
const Sch = (() => {
  let svg, world, grid, vp, boxEl;
  const ui = { sel: null, multi: new Set(), selNet: null, selPin: null, pending: null, mouse: { x: 0, y: 0 }, drag: null, pan: null, box: null, rdown: null, onSelect: () => { }, onContext: () => { }, sheet: 0 };
  // ---------- sheets (multi-page schematic) and the drawing frame ----------
  const sheets = () => (Model.S.sheets && Model.S.sheets.length ? Model.S.sheets : [{ name: 'Main' }]);
  const onSheet = c => Model.sheetOf(c) === ui.sheet;
  function contentBox(sh = ui.sheet) {
    const cs = Model.S.components.filter(c => Model.sheetOf(c) === sh); if (!cs.length) return [-200, -120, 200, 120];
    const idx = Model.pinIndex(); let b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const c of cs) { const a = Model.labelBox(c, idx); b = [Math.min(b[0], a[0]), Math.min(b[1], a[1]), Math.max(b[2], a[2]), Math.max(b[3], a[3])]; }
    return b;
  }
  const frameOn = () => Model.S.schFrame !== false;
  // landscape A-series sheet around the content, title block bottom-right
  function frameGeom(sh = ui.sheet) {
    const b = contentBox(sh), m = 40, bd = 12, tbW = 320, tbH = 78;
    let w = Math.max(b[2] - b[0] + 2 * m + 2 * bd, tbW + 2 * bd + 120), h = b[3] - b[1] + 2 * m + tbH + 2 * bd;
    if (w / h < Math.SQRT2) w = h * Math.SQRT2; else h = w / Math.SQRT2;
    const x0 = (b[0] + b[2]) / 2 - w / 2, y0 = b[1] - m - bd;
    return { x0, y0, w, h, bd, tbW, tbH, size: w <= 1200 ? 'A4' : w <= 1700 ? 'A3' : w <= 2400 ? 'A2' : 'A1' };
  }
  function frameSVG() {
    const F = frameGeom(), S = Model.S, d = Object.assign({ title: S.name || 'Untitled', company: '', version: '1.0' }, S.doc || {}), sh = sheets();
    const { x0, y0, w, h, bd, tbW, tbH } = F, ix0 = x0 + bd, iy0 = y0 + bd, ix1 = x0 + w - bd, iy1 = y0 + h - bd;
    const cols = w > 1700 ? 8 : 6, rows = 4, e = esc;
    let s = `<g class="frame"><rect class="fo" x="${x0}" y="${y0}" width="${w}" height="${h}"/><rect class="fi" x="${ix0}" y="${iy0}" width="${ix1 - ix0}" height="${iy1 - iy0}"/>`;
    for (let i = 0; i < cols; i++) { const x = ix0 + (ix1 - ix0) * (i + 0.5) / cols, xl = ix0 + (ix1 - ix0) * i / cols; if (i) s += `<path class="ft" d="M${xl} ${y0}V${iy0}M${xl} ${iy1}V${y0 + h}"/>`; s += `<text class="fz" x="${x}" y="${y0 + bd - 3.5}" text-anchor="middle">${i + 1}</text><text class="fz" x="${x}" y="${y0 + h - 3.5}" text-anchor="middle">${i + 1}</text>`; }
    for (let j = 0; j < rows; j++) { const y = iy0 + (iy1 - iy0) * (j + 0.5) / rows, yl = iy0 + (iy1 - iy0) * j / rows, L = 'ABCDEFGH'[j]; if (j) s += `<path class="ft" d="M${x0} ${yl}H${ix0}M${ix1} ${yl}H${x0 + w}"/>`; s += `<text class="fz" x="${x0 + bd / 2}" y="${y + 3}" text-anchor="middle">${L}</text><text class="fz" x="${x0 + w - bd / 2}" y="${y + 3}" text-anchor="middle">${L}</text>`; }
    const tx = ix1 - tbW, ty = iy1 - tbH, r1 = 30, r2 = 24;
    s += `<rect class="tb" x="${tx}" y="${ty}" width="${tbW}" height="${tbH}"/><path class="fi" d="M${tx} ${ty + r1}H${ix1}M${tx} ${ty + r1 + r2}H${ix1}M${tx + 200} ${ty + r1}V${ty + r1 + r2}M${tx + 120} ${ty + r1 + r2}V${iy1}M${tx + 230} ${ty + r1 + r2}V${iy1}"/>`;
    const lab = (x, y, t) => `<text class="tbl" x="${x + 4}" y="${y + 8}">${t}</text>`, val = (x, y, t, cls = 'tbv') => `<text class="${cls}" x="${x + 4}" y="${y}">${e(t)}</text>`;
    s += lab(tx, ty, 'TITLE') + val(tx, ty + 24, d.title, 'tbt');
    s += lab(tx, ty + r1, 'COMPANY / AUTHOR') + val(tx, ty + r1 + 19, d.company || '—') + lab(tx + 200, ty + r1, 'DOCUMENT') + val(tx + 200, ty + r1 + 19, (S.name || 'design').slice(0, 22));
    s += lab(tx, ty + r1 + r2, 'SHEET') + val(tx, ty + tbH - 6, `${ui.sheet + 1} of ${sh.length} · ${(sh[ui.sheet] || {}).name || ''}`) + lab(tx + 120, ty + r1 + r2, 'DATE') + val(tx + 120, ty + tbH - 6, d.date || new Date().toISOString().slice(0, 10));
    s += lab(tx + 230, ty + r1 + r2, 'REV / SIZE') + val(tx + 230, ty + tbH - 6, `${d.version} · ${F.size}`) + '</g>';
    return s;
  }
  function sheetBar() {
    let bar = document.getElementById('sheetBar');
    if (!bar) { bar = document.createElement('div'); bar.id = 'sheetBar'; bar.className = 'sheetbar'; svg.parentNode.appendChild(bar); bar.onclick = sheetClick; bar.ondblclick = sheetRename; }
    const sh = sheets(), n = Model.S.components.filter(c => Model.sheetOf(c) === ui.sheet).length;
    bar.innerHTML = sh.map((s, i) => `<button data-sheet="${i}" class="${i === ui.sheet ? 'on' : ''}" title="Double-click to rename">${i + 1}: ${esc(s.name || 'Sheet ' + (i + 1))}</button>`).join('') +
      `<button data-sheet="add" title="Add a sheet">＋</button>${sh.length > 1 && !n ? '<button data-sheet="del" title="Delete this empty sheet">✕</button>' : ''}<label class="sfr"><input type="checkbox" ${frameOn() ? 'checked' : ''} data-sheet="frame"> frame</label>`;
  }
  function sheetClick(e) {
    const b = e.target.closest('[data-sheet]'); if (!b) return;
    const k = b.dataset.sheet;
    if (k === 'frame') { Model.mutate(() => { Model.S.schFrame = b.checked; }); return; }
    if (k === 'add') { Model.mutate(() => { const sh = sheets().slice(); sh.push({ name: 'Sheet ' + (sh.length + 1) }); Model.S.sheets = sh; }); ui.sheet = sheets().length - 1; select(null); render(); fit(); return; }
    if (k === 'del') { const i = ui.sheet; Model.mutate(() => { const sh = sheets().slice(); sh.splice(i, 1); Model.S.sheets = sh; for (const c of Model.S.components) if (Model.sheetOf(c) > i) c.sheet = Model.sheetOf(c) - 1; }); ui.sheet = Math.max(0, i - 1); render(); fit(); return; }
    ui.sheet = +k; select(null); render(); fit();
  }
  function sheetRename(e) {
    const b = e.target.closest('[data-sheet]'); if (!b || isNaN(+b.dataset.sheet)) return;
    const i = +b.dataset.sheet, n = prompt('Sheet name', sheets()[i].name || ''); if (n == null) return;
    Model.mutate(() => { const sh = sheets().map(s => Object.assign({}, s)); sh[i].name = n.trim() || 'Sheet ' + (i + 1); Model.S.sheets = sh; });
  }

  function init(el) {
    svg = el;
    svg.innerHTML = `<defs><pattern id="sgrid" width="10" height="10" patternUnits="userSpaceOnUse"><circle cx="0" cy="0" r="0.7" class="griddot"/></pattern></defs>
      <rect id="sgridr" fill="url(#sgrid)"/><g id="sworld"></g><rect id="sbox" class="boxsel" style="display:none"/>`;
    world = svg.querySelector('#sworld'); grid = svg.querySelector('#sgridr'); boxEl = svg.querySelector('#sbox');
    vp = new Viewport(svg, { min: 0.3, max: 12, scale: 2, onChange: vb => { grid.setAttribute('x', vb[0]); grid.setAttribute('y', vb[1]); grid.setAttribute('width', vb[2]); grid.setAttribute('height', vb[3]); } });
    svg.addEventListener('mousedown', down);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  // ---------- geometry helpers ----------
  const mdist = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  function mst(pts) {
    const n = pts.length, inT = new Array(n).fill(false), best = new Array(n).fill(Infinity), par = new Array(n).fill(-1), E = [];
    if (!n) return E; best[0] = 0;
    for (let it = 0; it < n; it++) {
      let u = -1; for (let i = 0; i < n; i++) if (!inT[i] && (u < 0 || best[i] < best[u])) u = i;
      inT[u] = true; if (par[u] >= 0) E.push([par[u], u]);
      for (let v = 0; v < n; v++) if (!inT[v]) { const d = mdist(pts[u], pts[v]); if (d < best[v]) { best[v] = d; par[v] = u; } }
    }
    return E;
  }
  function segHits(x1, y1, x2, y2, boxes) {
    let h = 0; const sx0 = Math.min(x1, x2), sx1 = Math.max(x1, x2), sy0 = Math.min(y1, y2), sy1 = Math.max(y1, y2);
    for (const b of boxes) if (sx1 > b[0] + 1 && sx0 < b[2] - 1 && sy1 > b[1] + 1 && sy0 < b[3] - 1) h++;
    return h;
  }
  function route(a, b, boxes) {
    if (a.x === b.x || a.y === b.y) return [a, b];
    const e1 = { x: b.x, y: a.y }, e2 = { x: a.x, y: b.y };
    const s1 = segHits(a.x, a.y, e1.x, e1.y, boxes) + segHits(e1.x, e1.y, b.x, b.y, boxes);
    const s2 = segHits(a.x, a.y, e2.x, e2.y, boxes) + segHits(e2.x, e2.y, b.x, b.y, boxes);
    if (s1 !== s2) return [a, s1 < s2 ? e1 : e2, b];
    return [a, a.dx ? e1 : e2, b];
  }
  // Wires of all nets on a 10-unit grid. Each net starts at one pin; every other pin is joined to the nearest point of
  // the net's wires so far (Dijkstra over cell + direction: steps, bends cost extra, crossing another net's wire costs
  // extra, running along it, through a symbol or over another net's pin / corner is not allowed). Returns per net
  // { d (SVG path), junctions }, or null when the sheet is too big for the grid (then the plain L wires are used).
  const routeMemo = { key: null, val: null };
  function mazeRoute(jobs, boxes, solid = [], tips = []) {
    const G = 10; let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const j of jobs) for (const p of j.pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    for (const b of boxes) { x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]); }
    x0 = Math.floor(x0 / G) * G - 60; y0 = Math.floor(y0 / G) * G - 60;
    const W = Math.ceil((x1 + 60 - x0) / G) + 1, H = Math.ceil((y1 + 60 - y0) / G) + 1, N = W * H;
    if (!jobs.length || N > 300000) return null;
    const ci = (x, y) => Math.round((y - y0) / G) * W + Math.round((x - x0) / G);
    const block = new Uint8Array(N), hOwn = new Int32Array(N), vOwn = new Int32Array(N), pinOwn = new Int32Array(N), nodeOwn = new Int32Array(N);
    for (const b of boxes) {
      const i0 = Math.floor((b[0] - x0) / G) + 1, i1 = Math.ceil((b[2] - x0) / G) - 1, j0 = Math.floor((b[1] - y0) / G) + 1, j1 = Math.ceil((b[3] - y0) / G) - 1;
      for (let j = Math.max(0, j0); j <= Math.min(H - 1, j1); j++) for (let i = Math.max(0, i0); i <= Math.min(W - 1, i1); i++) block[j * W + i] = 1;
    }
    // power symbols (GND, +3V3 …) and their stubs: no wire through them
    for (const b of solid) {
      const i0 = Math.ceil((b[0] - x0) / G), i1 = Math.floor((b[2] - x0) / G), j0 = Math.ceil((b[1] - y0) / G), j1 = Math.floor((b[3] - y0) / G);
      for (let j = Math.max(0, j0); j <= Math.min(H - 1, j1); j++) for (let i = Math.max(0, i0); i <= Math.min(W - 1, i1); i++) block[j * W + i] = 1;
    }
    // every pin end belongs to its net (an unconnected pin to nobody): no other wire may touch it
    for (const p of tips) { const k = ci(p.x, p.y); if (k >= 0 && k < N) pinOwn[k] = -1; }
    jobs.forEach((jb, n) => { for (const p of jb.pts) { const k = ci(p.x, p.y); if (k >= 0 && k < N) { pinOwn[k] = n + 1; block[k] = 0; } } });
    const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1], INF = 1e9, dist = new Float64Array(N * 4), prev = new Int32Array(N * 4);
    // binary heap of [cost, state]
    let hc = [], hs = [];
    const push = (c, s) => { let i = hc.length; hc.push(c); hs.push(s); while (i) { const p = (i - 1) >> 1; if (hc[p] <= c) break; hc[i] = hc[p]; hs[i] = hs[p]; i = p; } hc[i] = c; hs[i] = s; };
    const pop = () => { const s = hs[0], c = hc.pop(), t = hs.pop(); if (hc.length) { let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; const cm = () => m === i ? c : hc[m]; if (l < hc.length && hc[l] < cm()) m = l; if (r < hc.length && hc[r] < cm()) m = r; if (m === i) break; hc[i] = hc[m]; hs[i] = hs[m]; i = m; } hc[i] = c; hs[i] = t; } return s; };
    const out = new Map();
    jobs.forEach((jb, n) => {
      const id = n + 1, tree = new Uint8Array(N), segs = [], deg = new Map();
      const mark = (a, b) => {   // a unit step between two cells of this net
        const horiz = Math.abs(a - b) === 1; (horiz ? hOwn : vOwn)[a] = id; (horiz ? hOwn : vOwn)[b] = id;
        tree[a] = tree[b] = 1; deg.set(a, (deg.get(a) || 0) + 1); deg.set(b, (deg.get(b) || 0) + 1);
      };
      const pins = jb.pts.map(p => ({ p, k: ci(p.x, p.y) }));
      // pins nearest first, so the tree grows outward
      const order = [pins[0]], left = pins.slice(1);
      while (left.length) { let bi = 0, bd = Infinity; left.forEach((q, i) => { const d = Math.min(...order.map(o => Math.abs(o.p.x - q.p.x) + Math.abs(o.p.y - q.p.y))); if (d < bd) { bd = d; bi = i; } }); order.push(left.splice(bi, 1)[0]); }
      tree[order[0].k] = 1; nodeOwn[order[0].k] = id;
      const failed = [];
      for (const { p, k } of order.slice(1)) {
        if (tree[k]) continue;
        dist.fill(INF); hc = []; hs = [];
        // leave the pin outward first (when that cell is free)
        const pd = DX.findIndex((v, i) => v === (p.dx || 0) && DY[i] === (p.dy || 0));
        for (let d = 0; d < 4; d++) { const s = k * 4 + d, c0 = d === pd ? 0 : 6; dist[s] = c0; prev[s] = -1; push(c0, s); }
        let goal = -1;
        while (hc.length) {
          const s = pop(), c = dist[s], cell = s >> 2, dir = s & 3;
          if (tree[cell] && cell !== k) { goal = s; break; }
          if (c > 4000) break;
          const ix = cell % W, iy = (cell - ix) / W;
          for (let d = 0; d < 4; d++) {
            if (d === ((dir + 2) & 3) && cell !== k) continue;
            const nx = ix + DX[d], ny = iy + DY[d]; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const nc = ny * W + nx, horiz = d === 0 || d === 2;
            if (block[nc] && !tree[nc]) continue;
            if (pinOwn[nc] && pinOwn[nc] !== id) continue;
            if (nodeOwn[nc] && nodeOwn[nc] !== id) continue;
            const own = horiz ? hOwn : vOwn, cross = horiz ? vOwn : hOwn;
            if ((own[nc] && own[nc] !== id) || (own[cell] && own[cell] !== id)) continue;   // along another net's wire
            let step = 1 + (d !== dir && cell !== k ? 4 : 0) + (cross[nc] && cross[nc] !== id && !tree[nc] ? 8 : 0);
            if (d !== dir && cell !== k && cross[cell] && cross[cell] !== id) continue;   // no corner on another net's wire
            const ns = nc * 4 + d, v = c + step; if (v < dist[ns]) { dist[ns] = v; prev[ns] = s; push(v, ns); }
          }
        }
        if (goal < 0) { failed.push(p); continue; }
        // walk back: cells from the tree to the pin
        const cells = []; for (let s = goal; s >= 0; s = prev[s]) { const cell = s >> 2; if (cells[cells.length - 1] !== cell) cells.push(cell); }
        for (let i = 1; i < cells.length; i++) mark(cells[i - 1], cells[i]);
        // corners and ends of this net may not be crossed by others
        for (let i = 0; i < cells.length; i++) { const a = cells[i - 1], b = cells[i + 1]; if (a == null || b == null || (a - cells[i]) !== (cells[i] - b)) nodeOwn[cells[i]] = id; }
        segs.push(cells);
      }
      // SVG: each path as straight runs; junctions where 3+ wire ends meet (a pin counts as one)
      let d = '', run = null;
      const cx = c => x0 + (c % W) * G, cy = c => y0 + Math.floor(c / W) * G;
      for (const cells of segs) {
        const pts = [cells[0]]; for (let i = 1; i < cells.length - 1; i++) if (cells[i] - cells[i - 1] !== cells[i + 1] - cells[i]) pts.push(cells[i]); pts.push(cells[cells.length - 1]);
        d += 'M' + pts.map(c => cx(c) + ' ' + cy(c)).join('L');
        // the longest horizontal run carries the net name (above it, clear of the pins)
        for (let i = 1; i < pts.length; i++) if (cy(pts[i]) === cy(pts[i - 1])) { const l = Math.abs(cx(pts[i]) - cx(pts[i - 1])); if (!run || l > run.l) run = { l, x: (cx(pts[i]) + cx(pts[i - 1])) / 2, y: cy(pts[i]) }; }
      }
      // pins off the 10 grid: a short stub to the grid point
      for (const { p, k } of pins) if (cx(k) !== p.x || cy(k) !== p.y) d += `M${p.x} ${p.y}L${cx(k)} ${cy(k)}`;
      const junctions = [];
      for (const [c, n0] of deg) { const n1 = n0 + (pins.some(q => q.k === c) ? 1 : 0); if (n1 >= 3) junctions.push([cx(c), cy(c)]); }
      out.set(jb.net, { d, junctions, failed, name: run && run.l >= 30 ? [run.x, run.y] : null });
    });
    return out;
  }
  const angFor = (d, upIsAway) => { // rotation so that local -y (power) or +y (ground) points along d
    const k = `${d.dx},${d.dy}`;
    if (upIsAway) return { '0,-1': 0, '1,0': 90, '0,1': 180, '-1,0': 270 }[k] ?? 0;
    return { '0,1': 0, '-1,0': 90, '0,-1': 180, '1,0': 270 }[k] ?? 0;
  };

  // ---------- render ----------
  function render() {
    const S = Model.S, out = [], pinPos = {}, boxes = [];
    const idx = Model.pinIndex();
    if (ui.sheet >= sheets().length) ui.sheet = sheets().length - 1;
    const here = S.components.filter(onSheet), elsewhere = new Set(S.components.filter(c => !onSheet(c)).map(c => c.ref));
    if (frameOn() && here.length) out.push(frameSVG());
    for (const c of here) {
      boxes.push(Model.bbox(c));
      for (const p of Model.pinsWorld(c)) pinPos[p.key] = p;
    }
    // nets drawn as wires go through the router together (labels and power symbols need none)
    const wireNet = (net, keys, pts) => !Model.isPower(net) && pts.length >= 2 && !keys.some(k => elsewhere.has(k.split('.')[0])) &&
      !(S.connStyle === 'labels' || (S.connStyle === 'auto' && mst(pts).some(([a, b]) => mdist(pts[a], pts[b]) > 320)));
    const jobs = [];
    for (const [net, keys] of Object.entries(S.nets)) { const pts = keys.map(k => pinPos[k]).filter(Boolean); if (wireNet(net, keys, pts)) jobs.push({ net, pts }); }
    // short nets first: they get the straight wires
    jobs.sort((a, b) => { const span = j => { const xs = j.pts.map(p => p.x), ys = j.pts.map(p => p.y); return Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys); }; return span(a) - span(b); });
    const solid = [];
    for (const [net, keys] of Object.entries(S.nets)) if (Model.isPower(net)) for (const k of keys) {
      const p = pinPos[k]; if (!p) continue;
      const ex = p.x + p.dx * 22, ey = p.y + p.dy * 22, w = p.dx ? 10 : 12, h = p.dy ? 10 : 12;
      solid.push([Math.min(p.x, ex) - (p.dy ? w : 0), Math.min(p.y, ey) - (p.dx ? h : 0), Math.max(p.x, ex) + (p.dy ? w : 0), Math.max(p.y, ey) + (p.dx ? h : 0)]);
    }
    // while a part is dragged the quick L wires are drawn; the router runs again when it is dropped (and is cached)
    // net labels (their stub and text) on this sheet: no wire of another net may run through them
    for (const [net, keys] of Object.entries(S.nets)) {
      if (Model.isPower(net)) continue;
      const pts = keys.map(k => pinPos[k]).filter(Boolean), off = keys.some(k => elsewhere.has(k.split('.')[0]));
      if (!pts.length || wireNet(net, keys, pts) || (pts.length < 2 && !off)) continue;
      const w = net.length * 5.2 + 4;
      for (const p of pts) {
        const ex = p.x + p.dx * 10, ey = p.y + p.dy * 10;
        solid.push(p.dx > 0 ? [p.x, ey - 8, ex + w, ey + 6] : p.dx < 0 ? [ex - w, ey - 8, p.x, ey + 6] : p.dy < 0 ? [ex - w / 2, ey - 14, ex + w / 2, p.y] : [ex - w / 2, p.y, ex + w / 2, ey + 12]);
      }
    }
    let routed = null;
    if (!(ui.drag && ui.drag.moved)) {
      const key = JSON.stringify([jobs.map(j => [j.net, j.pts.map(p => [p.x, p.y, p.dx, p.dy])]), boxes, solid]);
      if (routeMemo.key === key) routed = routeMemo.val;
      else { try { routed = mazeRoute(jobs, boxes, solid, Object.values(pinPos)); } catch (e) { routed = null; } routeMemo.key = key; routeMemo.val = routed; }
    }
    const junction = {};
    const bump = (p) => { const k = p.x + ',' + p.y; junction[k] = (junction[k] || 0) + 1; };
    for (const [net, keys] of Object.entries(S.nets)) {
      const pts = keys.map(k => pinPos[k]).filter(Boolean);
      if (!pts.length) continue;
      const offSheet = keys.some(k => elsewhere.has(k.split('.')[0]));   // continues on another sheet → net labels
      const selC = ui.selNet === net ? ' sel' : '';
      if (Model.isPower(net)) {
        const gnd = Model.isGround(net);
        for (const p of pts) {
          const ex = p.x + p.dx * 10, ey = p.y + p.dy * 10;
          out.push(`<g class="pwr${selC}" data-net="${esc(net)}" data-npin="${esc(p.key)}"><path class="wire" d="M${p.x} ${p.y}L${ex} ${ey}"/>`);
          if (gnd) out.push(`<path class="wire" transform="translate(${ex} ${ey}) rotate(${angFor(p, false)})" d="M-9 0H9M-6 4H6M-3 8H3"/>`);
          else {
            out.push(`<path class="wire" transform="translate(${ex} ${ey}) rotate(${angFor(p, true)})" d="M-7 0H7"/>`);
            const tx = ex + p.dx * 6, ty = ey + p.dy * 6 + (p.dy < 0 ? -2 : p.dy > 0 ? 8 : 3);
            out.push(`<text class="pwrtxt" x="${tx}" y="${ty}" text-anchor="${p.dx > 0 ? 'start' : p.dx < 0 ? 'end' : 'middle'}">${esc(net)}</text>`);
          }
          out.push('</g>');
        }
        continue;
      }
      if (pts.length < 2 && !offSheet) { for (const p of pts) out.push(`<circle class="dangle" cx="${p.x}" cy="${p.y}" r="2.5"/>`); continue; }
      const E = pts.length >= 2 ? mst(pts) : [];
      const useLabels = offSheet || S.connStyle === 'labels' || (S.connStyle === 'auto' && E.some(([a, b]) => mdist(pts[a], pts[b]) > 320));
      if (useLabels) {
        for (const p of pts) {
          const ex = p.x + p.dx * 10, ey = p.y + p.dy * 10;
          const anchor = p.dx > 0 ? 'start' : p.dx < 0 ? 'end' : 'middle';
          out.push(`<g class="netl${selC}" data-net="${esc(net)}" data-npin="${esc(p.key)}"><path class="wire" d="M${p.x} ${p.y}L${ex} ${ey}"/><path class="hitw" d="M${p.x} ${p.y}L${ex} ${ey}"/>` +
            `<text class="netlabel" x="${ex + p.dx * 2}" y="${ey + (p.dy < 0 ? -3 : p.dy > 0 ? 9 : 3)}" text-anchor="${anchor}">${esc(net)}</text></g>`);
        }
        continue;
      }
      let d = '';
      const R = routed && routed.get(net);
      if (R) {
        d = R.d;
        for (const [x, y] of R.junctions) junction[x + ',' + y] = 3;
        // pins the router could not reach: a plain wire to the nearest pin of the net
        for (const p of R.failed) { const q = pts.filter(o => o !== p).reduce((a, b) => mdist(a, p) <= mdist(b, p) ? a : b); d += 'M' + route(p, q, boxes).map(o => o.x + ' ' + o.y).join('L'); }
      } else {
        for (const [a, b] of E) {
          const r = route(pts[a], pts[b], boxes);
          d += 'M' + r.map(q => q.x + ' ' + q.y).join('L');
          bump(pts[a]); bump(pts[b]);
        }
        for (const p of pts) bump(p);
      }
      out.push(`<g class="netw${selC}" data-net="${esc(net)}"><path class="wire" d="${d}"/><path class="hitw" d="${d}"/>`);
      if (!/^N\$/.test(net) && R && R.name) out.push(`<text class="netname" x="${R.name[0]}" y="${R.name[1] - 3}" text-anchor="middle">${esc(net)}</text>`);
      else if (!/^N\$/.test(net) && !R) {
        const p = pts[E[0][0]];
        out.push(`<text class="netname" x="${p.x + p.dx * 4}" y="${p.y - 3}" text-anchor="${p.dx < 0 ? 'end' : 'start'}">${esc(net)}</text>`);
      }
      out.push('</g>');
    }
    for (const [k, n] of Object.entries(junction)) if (n >= 3) { const [x, y] = k.split(','); out.push(`<circle class="junc" cx="${x}" cy="${y}" r="2.6"/>`); }

    // components
    for (const c of here) {
      const d = Lib.type(c.type), b = Model.bbox(c), lb = d.box(c);
      out.push(`<g class="comp${isSel(c.ref) ? ' sel' : ''}" data-ref="${esc(c.ref)}"><g transform="translate(${c.x} ${c.y}) rotate(${c.rot || 0})">` +
        `<rect class="hit" x="${lb[0]}" y="${lb[1]}" width="${lb[2] - lb[0]}" height="${lb[3] - lb[1]}"/>${d.draw(c)}</g>`);
      const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
      if ((c.rot === 90 || c.rot === 270) && !d.generic && b[3] - b[1] > b[2] - b[0])
        out.push(`<text class="ref" x="${b[2] + 4}" y="${cy - 2}">${esc(c.ref)}</text><text class="val" x="${b[2] + 4}" y="${cy + 8}">${esc(c.value)}</text>`);
      else
        out.push(`<text class="ref" x="${cx}" y="${b[1] - 5}" text-anchor="middle">${esc(c.ref)}</text><text class="val" x="${cx}" y="${b[3] + 12}" text-anchor="middle">${esc(c.value)}</text>`);
      for (const p of Model.pinsWorld(c)) {
        if (p.show) {
          const tx = p.ax - p.dx * 4, ty = p.ay - p.dy * 4;
          const anchor = p.dx < 0 ? 'start' : p.dx > 0 ? 'end' : 'middle';
          out.push(`<text class="pinname" x="${tx}" y="${ty + (p.dy < 0 ? 8 : p.dy > 0 ? -2 : 3)}" text-anchor="${anchor}">${esc(p.name)}</text>`);
          if (p.len >= 20) out.push(`<text class="pinnum" x="${(p.x + p.ax) / 2}" y="${(p.y + p.ay) / 2 - 2}" text-anchor="middle">${esc(p.num)}</text>`);
        }
        out.push(`<circle class="pinhit${ui.pending === p.key ? ' pend' : ''}${idx[p.key] ? '' : ' open'}" data-pin="${esc(p.key)}" cx="${p.x}" cy="${p.y}" r="3.5"><title>${esc(p.key)} ${esc(p.name)}${idx[p.key] ? ' → ' + esc(idx[p.key]) : ''}</title></circle>`);
      }
      out.push('</g>');
    }
    if (ui.pending && pinPos[ui.pending]) {
      const p = pinPos[ui.pending];
      out.push(`<path class="rubber" d="M${p.x} ${p.y}L${ui.mouse.x} ${p.y}L${ui.mouse.x} ${ui.mouse.y}"/>`);
    }
    sheetBar();
    if (!here.length && S.components.length) out.push(`<text class="empty" x="0" y="0" text-anchor="middle">Sheet ${ui.sheet + 1} is empty — add parts here, or move parts to this sheet (Properties → Sheet)</text>`);
    if (!S.components.length) out.push('<text class="empty" x="0" y="0" text-anchor="middle">Add parts from the left panel — or ask the AI Copilot to design a circuit</text>');
    world.innerHTML = out.join('');
  }

  function extents() {
    const here = Model.S.components.filter(onSheet); if (!here.length) return [-200, -120, 200, 120];
    if (frameOn()) { const F = frameGeom(); return [F.x0, F.y0, F.x0 + F.w, F.y0 + F.h]; }
    return contentBox();
  }
  const fit = () => vp.fit(extents(), 40);
  // true when some part on this sheet lies completely outside the visible area (e.g. after an external tool moved it)
  function offscreen() {
    const vb = vp && vp.vb; if (!vb || !vb[2]) return false;
    return Model.S.components.filter(onSheet).some(c => { const b = Model.bbox(c); return b[2] < vb[0] || b[0] > vb[0] + vb[2] || b[3] < vb[1] || b[1] > vb[1] + vb[3]; });
  }

  // ---------- interaction ----------
  // selection: ui.sel is the primary part (Properties), ui.multi every selected part
  const isSel = ref => ui.sel === ref || ui.multi.has(ref);
  function selected() { const r = ui.multi.size ? [...ui.multi] : ui.sel ? [ui.sel] : []; return r.filter(x => Model.comp(x)); }
  function setSelection(refs) { ui.multi = new Set(refs); ui.sel = refs[0] || null; ui.selNet = null; ui.selPin = null; ui.onSelect(ui.sel, null); render(); }
  // pin: the pin whose symbol / label / wire end was clicked — Delete then disconnects only that pin
  function select(ref, net, pin) { ui.sel = ref || null; ui.multi = new Set(ref ? [ref] : []); ui.selNet = net || null; ui.selPin = (net && pin) || null; ui.onSelect(ui.sel, ui.selNet); render(); }
  // the pin of a net clicked: the symbol's own pin, else the net's pin on this sheet nearest to the click
  function netPin(el, pt) {
    if (el.dataset.npin) return el.dataset.npin;
    const keys = new Set(Model.S.nets[el.dataset.net] || []); let best = null, bd = Infinity;
    for (const c of Model.S.components.filter(onSheet)) for (const p of Model.pinsWorld(c)) if (keys.has(p.key)) { const d = Math.hypot(p.x - pt.x, p.y - pt.y); if (d < bd) { bd = d; best = p.key; } }
    return best;
  }
  function drawBox() {
    const b = ui.box; if (!b) { boxEl.style.display = 'none'; return; }
    boxEl.style.display = ''; boxEl.setAttribute('x', Math.min(b.x0, b.x1)); boxEl.setAttribute('y', Math.min(b.y0, b.y1));
    boxEl.setAttribute('width', Math.abs(b.x1 - b.x0)); boxEl.setAttribute('height', Math.abs(b.y1 - b.y0));
  }
  function down(e) {
    const pt = vp.toWorld(e.clientX, e.clientY);
    const pinEl = e.target.closest('[data-pin]'), compEl = e.target.closest('[data-ref]'), netEl = e.target.closest('[data-net]');
    if (e.button === 2) { ui.rdown = { x: e.clientX, y: e.clientY, ref: compEl ? compEl.dataset.ref : null, net: !compEl && netEl ? netEl.dataset.net : null, pin: !compEl && netEl ? netPin(netEl, vp.toWorld(e.clientX, e.clientY)) : null }; ui.pan = { x: e.clientX, y: e.clientY }; e.preventDefault(); return; }
    if (e.button === 1) { ui.pan = { x: e.clientX, y: e.clientY }; e.preventDefault(); return; }
    if (pinEl) {
      const k = pinEl.dataset.pin;
      if (ui.pending && ui.pending !== k) {
        const a = ui.pending; ui.pending = null;
        try { const n = Model.mutate(() => Model.connect(null, [a, k])); select(null, n); } catch (err) { App.toast(err.message); }
      } else { ui.pending = ui.pending === k ? null : k; render(); }
      return;
    }
    if (ui.pending) { ui.pending = null; render(); }
    if (compEl) {
      const c = Model.comp(compEl.dataset.ref);
      if (e.shiftKey || e.ctrlKey || e.metaKey) { // add to / remove from the selection
        const m = new Set(selected()); if (m.has(c.ref)) m.delete(c.ref); else m.add(c.ref);
        setSelection([...m].sort((a, b) => (a === c.ref ? -1 : b === c.ref ? 1 : 0))); return;
      }
      if (ui.multi.size > 1 && ui.multi.has(c.ref)) { ui.sel = c.ref; ui.onSelect(c.ref, null); render(); }   // keep the group
      else select(c.ref);
      ui.drag = { x0: pt.x, y0: pt.y, orig: selected().map(r => { const o = Model.comp(r); return [o, o.x, o.y]; }), moved: false };
    } else if (netEl) select(null, netEl.dataset.net, netPin(netEl, pt));
    else { // drag on empty space: selection box (Shift adds to the selection)
      if (!e.shiftKey) select(null);
      ui.box = { x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y, add: e.shiftKey ? selected() : [] }; drawBox();
    }
  }
  function move(e) {
    if (!svg || svg.classList.contains('hidden')) return;
    if (ui.pan) { vp.panBy(e.clientX - ui.pan.x, e.clientY - ui.pan.y); ui.pan = { x: e.clientX, y: e.clientY }; return; }
    const pt = vp.toWorld(e.clientX, e.clientY); ui.mouse = pt;
    if (ui.box) { ui.box.x1 = pt.x; ui.box.y1 = pt.y; drawBox(); return; }
    if (ui.drag) {
      const dx = Math.round((pt.x - ui.drag.x0) / 10) * 10, dy = Math.round((pt.y - ui.drag.y0) / 10) * 10, [c0, x0, y0] = ui.drag.orig[0] || [];
      if (c0 && (c0.x !== x0 + dx || c0.y !== y0 + dy)) {
        if (!ui.drag.moved) { Model.begin(); ui.drag.moved = true; }
        for (const [c, x, y] of ui.drag.orig) { c.x = x + dx; c.y = y + dy; }
        Model.emit('move');
      }
    } else if (ui.pending) render();
  }
  function up(e) {
    if (ui.box) {
      const b = ui.box, x0 = Math.min(b.x0, b.x1), x1 = Math.max(b.x0, b.x1), y0 = Math.min(b.y0, b.y1), y1 = Math.max(b.y0, b.y1);
      ui.box = null; drawBox();
      if (x1 - x0 > 3 || y1 - y0 > 3) {
        const hit = Model.S.components.filter(onSheet).filter(c => { const q = Model.bbox(c); return q[0] < x1 && q[2] > x0 && q[1] < y1 && q[3] > y0; }).map(c => c.ref);
        setSelection([...new Set([...b.add, ...hit])]);
      }
    }
    if (ui.rdown && e && e.button === 2) {
      const r = ui.rdown; ui.rdown = null;
      if (Math.hypot(e.clientX - r.x, e.clientY - r.y) <= 4) {   // right click (not a pan): context menu
        if (r.ref && !isSel(r.ref)) select(r.ref); else if (r.net) select(null, r.net, r.pin);
        ui.mouse = vp.toWorld(e.clientX, e.clientY);
        ui.onContext({ x: e.clientX, y: e.clientY, ref: r.ref, net: r.net });
      }
    }
    const dr = ui.drag; ui.drag = null; ui.pan = null;
    if (dr && dr.moved) Model.emit('change'); else if (dr) render();   // wires routed again after a drag
  }

  function key(e) {
    if (e.key === 'Escape') { ui.pending = null; select(null); return true; }
    if ((e.key === 'r' || e.key === 'R') && selected().length) { rotate(); return true; }
    if ((e.key === 'Delete' || e.key === 'Backspace')) {
      if (selected().length) { del(); return true; }
      if (ui.selNet) { disconnectSel(); return true; }
    }
    return false;
  }
  // Delete on a net: only the clicked pin leaves it (the whole net goes only with "Delete net")
  function disconnectSel() {
    const n = ui.selNet, pin = ui.selPin; select(null);
    if (pin) Model.mutate(() => Model.disconnect([pin])); else Model.mutate(() => Model.removeNet(n));
  }
  function rotate() { const refs = selected(); Model.mutate(() => { for (const r of refs) { const c = Model.comp(r); c.rot = ((c.rot || 0) + 90) % 360; } }); }
  function del() { const refs = selected(); select(null); Model.mutate(() => { for (const r of refs) if (Model.comp(r)) Model.removeComponent(r); }); }
  const selectAll = () => setSelection(Model.S.components.filter(onSheet).map(c => c.ref));
  function placeNew(type) {
    const vb = vp.vb || [0, 0, 0, 0];
    const c = Model.mutate(() => Model.addComponent({ type, x: vb[0] + vb[2] / 2, y: vb[1] + vb[3] / 2, sheet: ui.sheet }));
    select(c.ref);
  }
  // SVG of one sheet (default: the current one) for export / documents
  function exportSVG(sheet) {
    const keep = ui.sheet; if (sheet != null && sheet !== ui.sheet) { ui.sheet = sheet; render(); }
    const b = extents(), pad = frameOn() ? 4 : 30, w = b[2] - b[0] + 2 * pad, h = b[3] - b[1] + 2 * pad;
    const css = `.frame text{font-family:sans-serif}.fo,.fi,.tb{fill:none;stroke:#333;stroke-width:1}.fo{stroke-width:1.6}.ft{stroke:#333;stroke-width:0.8}.fz{font-size:8px;fill:#333}.tbl{font-size:6px;fill:#555}.tbv{font-size:10px;fill:#111}.tbt{font-size:16px;font-weight:700;fill:#111}` + `.wire{stroke:#0a7a3a;stroke-width:1.5;fill:none}.hitw,.hit,.pinhit{display:none}.comp path,.comp rect,.comp circle{stroke:#9b1b1b;stroke-width:1.5;fill:none}.comp .body{fill:#fff8e6}.comp .fill{fill:#9b1b1b}.comp .thick{stroke-width:2.5}text{font:8px sans-serif;fill:#333}.ref{fill:#1c4a8a;font-weight:600}.val{fill:#555}.pinname,.pinnum{font-size:6px}.netlabel,.netname,.pwrtxt{fill:#0a7a3a;font-weight:600}.junc{fill:#0a7a3a}.dangle,.rubber,.empty{display:none}`;
    const out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${b[0] - pad} ${b[1] - pad} ${w} ${h}" width="${w * 2}" height="${h * 2}"><style>${css}</style><rect x="${b[0] - pad}" y="${b[1] - pad}" width="${w}" height="${h}" fill="#fff"/>${world.innerHTML}</svg>`;
    if (ui.sheet !== keep) { ui.sheet = keep; render(); }
    return out;
  }
  const setSheet = i => { ui.sheet = Math.max(0, Math.min(sheets().length - 1, +i || 0)); select(null); render(); fit(); };
  return { init, render, fit, offscreen, key, select, disconnectSel, selected, setSelection, selectAll, rotate, del, placeNew, exportSVG, ui, sheets, setSheet, onSheet, get vp() { return vp; } };
})();
