'use strict';
// PCB editor: Layers panel, PCB Tools (select / track / via / measure),
// interactive routing with layer switching, live clearance check, track & via editing.
const PcbView = (() => {
  // default layer colours
  const LAYERS = [
    { id: 'F', name: 'TopLayer', color: '#FF0000', copper: true },
    { id: 'B', name: 'BottomLayer', color: '#0000FF', copper: true },
    { id: 'FS', name: 'TopSilkLayer', color: '#FFCC00' },
    { id: 'BS', name: 'BottomSilkLayer', color: '#66CC33' },
    { id: 'FM', name: 'TopSolderMaskLayer', color: '#800080', off: true },
    { id: 'BM', name: 'BottomSolderMaskLayer', color: '#AA00FF', off: true },
    { id: 'MU', name: 'Multi-Layer', color: '#C0C0C0' },
    { id: 'HO', name: 'HoleLayer', color: '#222222' },
    { id: 'OL', name: 'BoardOutline', color: '#FF00FF' },
    { id: 'RA', name: 'RatlineLayer', color: '#6464FF' },
    { id: 'DRC', name: 'DRCErrorLayer', color: '#FAD609' },
  ];
  const TOOLS = [
    { id: 'select', key: 'S', name: 'Select / move', icon: '<path d="M5 3l12 9-5 1 3 6-2 1-3-6-4 4z"/>' },
    { id: 'track', key: 'W', name: 'Track', icon: '<path d="M3 18h6l6-12h6" fill="none" stroke-width="2.4"/>' },
    { id: 'via', key: 'V', name: 'Via', icon: '<circle cx="12" cy="12" r="7" fill="none" stroke-width="2.6"/><circle cx="12" cy="12" r="2.4"/>' },
    { id: 'arc', key: 'A', name: 'Arc track', icon: '<path d="M4 19A15 15 0 0 1 20 5" fill="none" stroke-width="2.4"/>' },
    { id: 'pour', key: 'E', name: 'Copper area (pour)', icon: '<path d="M4 6l7-3 9 4-2 12-12 1z" stroke-width="1.6" opacity="0.85"/>' },
    { id: 'keepout', key: 'K', name: 'Keep-out area (no tracks / vias / copper pour inside): click corners, click the first corner to close', icon: '<path d="M4 4h16v16H4z" fill="none" stroke-width="2" stroke-dasharray="3 2"/><path d="M8 8l8 8M16 8l-8 8" stroke-width="2"/>' },
    { id: 'text', key: 'T', name: 'Text on the silkscreen (click to place on the active side)', icon: '<path d="M5 5h14M12 5v14M9 19h6" fill="none" stroke-width="2.4"/>' },
    { id: 'measure', key: 'M', name: 'Measure', icon: '<path d="M3 16l13-13 5 5-13 13z" fill="none" stroke-width="1.8"/><path d="M7 12l2 2M10 9l2 2M13 6l2 2" stroke-width="1.6"/>' },
  ];
  const GRIDS = [0.05, 0.1, 0.127, 0.254, 0.5, 1.27];
  const ui = {
    sel: null, multi: new Set(), box: null, onContext: () => { }, item: null, hlNet: null, drc: null, tool: 'select', active: 'F', angle: '45', flip: false, grid: 0.254, width: null, dim: true,
    route: null, measure: null, cursor: null, layers: {}, onSelect: () => { }, arc: null, poly: null, outlineR: 0,
  };
  LAYERS.forEach(l => ui.layers[l.id] = { on: !l.off, color: l.color });
  try { const s = JSON.parse(localStorage.getItem('cp.pcbView') || '{}'); if (s.layers) for (const k in s.layers) if (ui.layers[k]) Object.assign(ui.layers[k], s.layers[k]); ['grid', 'angle', 'dim'].forEach(k => { if (s[k] != null) ui[k] = s[k]; }); } catch (e) { }
  const persist = () => { try { localStorage.setItem('cp.pcbView', JSON.stringify({ layers: ui.layers, grid: ui.grid, angle: ui.angle, dim: ui.dim })); } catch (e) { } };
  const vis = id => ui.layers[id].on, col = id => ui.layers[id].color;
  // parts on a hidden side (its copper layer switched off) cannot be picked, dragged or box-selected
  const partVisible = c => vis(Pcb.isBottom(c) ? 'B' : 'F');
  // track ends sitting on a via (same net): [track index, point index]
  function viaEnds(v) {
    const out = [];
    Model.S.pcb.traces.forEach((t, i) => { if (v.net && t.net && t.net !== v.net) return; for (const k of [0, t.pts.length - 1]) if (Math.hypot(t.pts[k][0] - v.x, t.pts[k][1] - v.y) < 1e-3) out.push([i, k]); });
    return out;
  }
  const LNAME = { F: 'TopLayer', B: 'BottomLayer' };

  let svg, world, grid, vp, overlay, boxEl, cache = { pads: [] };
  const $ = s => document.querySelector(s);
  const G = Pcb.geom;

  // ---------- setup ----------
  function init(el) {
    svg = el;
    svg.innerHTML = `<defs><pattern id="pgrid" width="2.54" height="2.54" patternUnits="userSpaceOnUse"><circle cx="0" cy="0" r="0.07" fill="#3a3a3a"/></pattern></defs><rect id="pgridr" fill="url(#pgrid)"/><g id="pworld"></g><rect id="pbox" class="boxsel" style="display:none"/>`;
    world = svg.querySelector('#pworld'); grid = svg.querySelector('#pgridr'); boxEl = svg.querySelector('#pbox');
    vp = new Viewport(svg, { min: 2, max: 400, scale: 10, onChange: vb => { grid.setAttribute('x', vb[0]); grid.setAttribute('y', vb[1]); grid.setAttribute('width', vb[2]); grid.setAttribute('height', vb[3]); } });
    svg.addEventListener('mousedown', down); svg.addEventListener('dblclick', dbl);
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    svg.addEventListener('contextmenu', e => e.preventDefault());
    // floating palettes ("PCB Tools" and "Layers")
    overlay = document.createElement('div'); overlay.id = 'pcbOverlay'; overlay.className = 'hidden';
    overlay.innerHTML = `
      <div id="pcbPalette" class="fpanel"><div class="fph">PCB Tools</div>
        ${TOOLS.map(t => `<button class="tbtn" data-tool="${t.id}" title="${t.name} (${t.key})"><svg viewBox="0 0 24 24">${t.icon}</svg><span>${t.key}</span></button>`).join('')}
      </div>
      <div id="layerPanel" class="fpanel"><div class="fph"><span class="ltitle" title="Collapse / expand">▾ Layers</span> <span class="lq"><button data-q="all" title="Show all">All</button><button data-q="none" title="Hide all">None</button><button data-q="F" title="Top side only">Top</button><button data-q="B" title="Bottom side only">Bot</button></span></div>
        <div id="layerRows"></div>
        <label class="ldim"><input type="checkbox" id="ldim"> Dim inactive copper</label>
      </div>
      <div id="pcbCoord"></div>`;
    svg.parentElement.appendChild(overlay);
    overlay.querySelectorAll('[data-tool]').forEach(b => b.onclick = () => setTool(b.dataset.tool));
    overlay.querySelector('.lq').onclick = e => {
      const q = e.target.dataset.q; if (!q) return;
      for (const l of LAYERS) ui.layers[l.id].on = q === 'all' ? true : q === 'none' ? false :
        (q === 'F' ? !['B', 'BM'].includes(l.id) : !['F', 'FS', 'FM'].includes(l.id));
      if (q === 'F' || q === 'B') ui.active = q;
      persist(); renderLayers(); render(); syncBar();
    };
    $('#layerRows').onclick = e => {
      const row = e.target.closest('[data-l]'); if (!row) return; const id = row.dataset.l;
      if (e.target.closest('.leye')) { ui.layers[id].on = !ui.layers[id].on; persist(); }
      else if (e.target.closest('.lsw')) return; // colour picker
      else if (LAYERS.find(l => l.id === id).copper) { ui.active = id; ui.layers[id].on = true; if (ui.route) switchLayer(id); }
      renderLayers(); render(); syncBar();
    };
    $('#layerRows').oninput = e => { const row = e.target.closest('[data-l]'); if (row && e.target.type === 'color') { ui.layers[row.dataset.l].color = e.target.value; persist(); renderLayers(); render(); } };
    $('#ldim').onchange = e => { ui.dim = e.target.checked; persist(); render(); };
    overlay.querySelector('.ltitle').onclick = () => { const p = $('#layerPanel'); p.classList.toggle('collapsed'); overlay.querySelector('.ltitle').textContent = (p.classList.contains('collapsed') ? '▸' : '▾') + ' Layers'; };
    renderLayers(); setTool('select');
    if (svg.getBoundingClientRect().width < 900 || window.innerWidth < 1200) { $('#layerPanel').classList.add('collapsed'); overlay.querySelector('.ltitle').textContent = '▸ Layers'; }
  }
  function renderLayers() {
    $('#layerRows').innerHTML = LAYERS.map(l => `<div class="lrow${ui.active === l.id ? ' act' : ''}${ui.layers[l.id].on ? '' : ' off'}" data-l="${l.id}" title="${l.copper ? 'Click to make active (T / B)' : ''}">
      <span class="lact">${ui.active === l.id ? '✎' : ''}</span>
      <label class="lsw" style="background:${ui.layers[l.id].color}"><input type="color" value="${ui.layers[l.id].color}"></label>
      <span class="lname">${l.name}</span><span class="leye" title="Show / hide">${ui.layers[l.id].on ? '👁' : '—'}</span></div>`).join('');
    $('#ldim').checked = ui.dim;
  }
  function setVisible(on) { overlay && overlay.classList.toggle('hidden', !on); }
  function setTool(t) {
    if (ui.route && t !== 'track') finishRoute();
    ui.tool = t; ui.measure = null; ui.arc = null; ui.poly = null;
    overlay && overlay.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
    if (svg) svg.style.cursor = t === 'select' ? 'default' : 'crosshair';
    render(); coord();
  }
  // toolbar fields (active layer, width, angle, grid)
  function syncBar() {
    const L = $('#pLayer'); if (!L) return;
    L.value = ui.active; $('#pAngle').value = ui.angle; $('#pGrid').value = String(ui.grid);
    $('#pWidth').placeholder = 'auto ' + Pcb.rules().traceWidth;
  }
  function bindBar() {
    $('#pGrid').innerHTML = GRIDS.map(g => `<option value="${g}">${g} mm${g === 0.254 ? ' (10 mil)' : g === 0.127 ? ' (5 mil)' : g === 1.27 ? ' (50 mil)' : ''}</option>`).join('');
    $('#pLayer').onchange = e => { ui.active = e.target.value; ui.layers[ui.active].on = true; if (ui.route) switchLayer(ui.active); renderLayers(); render(); };
    $('#pAngle').onchange = e => { ui.angle = e.target.value; persist(); render(); };
    $('#pGrid').onchange = e => { ui.grid = +e.target.value; persist(); };
    $('#pWidth').oninput = e => { ui.width = +e.target.value > 0 ? +e.target.value : null; if (ui.route) { ui.route.w = curWidth(ui.route.net); render(); } };
    if ($('#pFree')) $('#pFree').onchange = e => { ui.free = e.target.checked; App.toast(ui.free ? 'No rules: tracks and vias go where you click — run DRC afterwards' : 'Rules on: segments and vias that break a clearance rule are not placed'); coord(); };
    syncBar();
  }
  const curWidth = net => ui.width || (net ? Pcb.netWidth(net) : Pcb.rules().traceWidth);

  // ---------- geometry helpers ----------
  const snapG = v => Math.round(v / ui.grid) * ui.grid;
  const L2 = () => Pcb.rules().layers === 1 ? ['F'] : ['F', 'B'];
  function allPads() {
    const idx = Model.pinIndex(); return Pcb.placed().flatMap(c => Pcb.padsOf(c, idx));
  }
  const padLayers = p => Pcb.padCu(p, L2());
  // object under a point on the given layer (or any visible layer): pad, via or track
  function hitObj(pt, layer) {
    for (const p of cache.pads) if ((!layer || padLayers(p).includes(layer)) && G.padDist(p, pt.x, pt.y) <= 0) return { k: 'pad', net: p.net, x: p.x, y: p.y, p, layer: p.drill ? null : (p.layer || 'F') };
    const S = Model.S;
    for (let i = 0; i < S.pcb.vias.length; i++) { const v = S.pcb.vias[i]; if (Math.hypot(pt.x - v.x, pt.y - v.y) <= v.d / 2) return { k: 'via', net: v.net, x: v.x, y: v.y, i }; }
    for (let i = S.pcb.traces.length - 1; i >= 0; i--) {
      const t = S.pcb.traces[i]; if (layer && t.layer !== layer) continue; if (!vis(t.layer)) continue;
      for (let s = 1; s < t.pts.length; s++) {
        const a = t.pts[s - 1], b = t.pts[s];
        if (G.ptSeg([pt.x, pt.y], a, b) <= t.w / 2) {
          const vx = b[0] - a[0], vy = b[1] - a[1], l2 = vx * vx + vy * vy, u = l2 ? Math.max(0, Math.min(1, ((pt.x - a[0]) * vx + (pt.y - a[1]) * vy) / l2)) : 0;
          return { k: 'track', net: t.net, x: a[0] + u * vx, y: a[1] + u * vy, i, s, layer: t.layer };
        }
      }
    }
    return null;
  }
  function snapPoint(pt, layer) {
    const o = hitObj(pt, layer);
    if (o) return { x: +o.x.toFixed(4), y: +o.y.toFixed(4), obj: o };
    return { x: +snapG(pt.x).toFixed(4), y: +snapG(pt.y).toFixed(4), obj: null };
  }
  // bend: straight + 45° (or 90°, or any angle); '/' flips the order
  function bend(a, b) {
    if (ui.angle === 'any') return [b];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    let c;
    if (ui.angle === '90') c = ui.flip ? [a[0], b[1]] : [b[0], a[1]];
    else {
      const adx = Math.abs(dx), ady = Math.abs(dy), d = Math.min(adx, ady), sx = Math.sign(dx), sy = Math.sign(dy);
      c = ui.flip ? [a[0] + sx * d, a[1] + sy * d] : (adx > ady ? [a[0] + sx * (adx - d), a[1]] : [a[0], a[1] + sy * (ady - d)]);
    }
    c = [+c[0].toFixed(4), +c[1].toFixed(4)];
    return (Math.hypot(c[0] - a[0], c[1] - a[1]) < 1e-6 || Math.hypot(c[0] - b[0], c[1] - b[1]) < 1e-6) ? [b] : [c, b];
  }
  // foreign copper on a layer, for the live clearance check
  function obstacles(layer, net) {
    const out = [], S = Model.S;
    for (const p of cache.pads) if (padLayers(p).includes(layer) && (!net || p.net !== net)) out.push({ s: G.padShape(p), what: 'pad ' + p.key, net: p.net, kind: 'pad', drill: p.drill, ring: p.drill ? (Math.min(p.w, p.h) - p.drill) / 2 : 0, c: [p.x, p.y] });
    for (const v of S.pcb.vias) if (!net || v.net !== net) out.push({ s: { k: 'circ', c: [v.x, v.y], r: v.d / 2 }, what: 'via', net: v.net, kind: 'via', drill: v.drill || Pcb.rules().viaDrill, ring: (v.d - (v.drill || Pcb.rules().viaDrill)) / 2, c: [v.x, v.y] });
    for (const t of S.pcb.traces) if (t.layer === layer && (!net || t.net !== net)) for (let i = 1; i < t.pts.length; i++) out.push({ s: { k: 'seg', a: t.pts[i - 1], b: t.pts[i], r: t.w / 2 }, what: 'track ' + (t.net || ''), net: t.net, kind: 'track' });
    (S.pcb.holes || []).forEach((h, i) => out.push({ s: { k: 'circ', c: [h.x, h.y], r: h.d / 2 }, what: 'mounting hole ' + (i + 1), kind: 'hole', drill: h.d, ring: 0, c: [h.x, h.y] }));
    const bp = Pcb.boardPoly(); for (let i = 0; i < bp.length; i++) out.push({ s: { k: 'seg', a: bp[i], b: bp[(i + 1) % bp.length], r: 0 }, what: 'board edge', kind: 'edge' });
    return out;
  }
  // gap a new track needs from an obstacle (the router's rules: pads, vias and drill holes keep more distance)
  function trackNeed(o, R0) {
    if (o.kind === 'pad') return o.drill ? Math.max(Pcb.padCl(R0), (+R0.minPthToTrack || 0) - o.ring) : Pcb.padCl(R0);
    if (o.kind === 'via') return Math.max(Pcb.viaCl(R0), (+R0.minHoleToTrack || 0) - o.ring);
    if (o.kind === 'hole') return Math.max(R0.clearance, +R0.minHoleToTrack || 0);
    if (o.kind === 'edge') return R0.edgeClearance;
    return R0.clearance;
  }
  // what a new via at p would violate (null when it fits): copper gaps on both layers, hole to track, hole to hole, edge
  function viaProblem(p, net, R0 = Pcb.rules()) {
    const d = R0.viaDiameter, drill = R0.viaDrill, vs = { k: 'circ', c: p, r: d / 2 }, ring = (d - drill) / 2; let worst = null;
    for (const L of ['F', 'B']) for (const o of obstacles(L, net)) {
      if (L === 'B' && o.kind !== 'track') continue;   // pads, vias, holes and the edge are listed for both layers: check once
      const need = o.kind === 'track' ? Math.max(Pcb.viaCl(R0), (+R0.minHoleToTrack || 0) - ring) : o.kind === 'edge' ? R0.edgeClearance : Math.max(Pcb.viaCl(R0), o.kind === 'pad' ? Pcb.padCl(R0) : 0);
      const gap = G.shapeDist(vs, o.s);
      if (gap < need - 1e-3 && (!worst || gap - need < worst.d - worst.need)) worst = { d: gap, need, what: o.what };
      if (o.drill && !worst) { const hh = Math.hypot(p[0] - o.c[0], p[1] - o.c[1]) - drill / 2 - o.drill / 2; if (hh < R0.minHoleToHole - 1e-3) worst = { d: hh, need: R0.minHoleToHole, what: o.what + ' (hole to hole)' }; }
    }
    return worst;
  }
  function checkClear(pts, w, route) {
    if (!route || pts.length < 2) return null;
    const R0 = Pcb.rules(); let worst = null;
    for (let i = 1; i < pts.length; i++) {
      const seg = { k: 'seg', a: pts[i - 1], b: pts[i], r: w / 2 };
      for (const o of route.obs) {
        if (route.startObj && o.what === 'pad ' + (route.startObj.p && route.startObj.p.key)) continue;
        if (route.net && o.net === route.net) continue;
        const d = G.shapeDist(seg, o.s), need = trackNeed(o, R0);
        if (d < need - 1e-3 && (!worst || d < worst.d)) worst = { d, what: o.what, need };
      }
    }
    return worst;
  }

  // ---------- interactive routing ----------
  function startRoute(sp) {
    let layer = ui.active;
    if (sp.obj && sp.obj.k === 'pad' && !sp.obj.p.drill && layer !== sp.obj.layer) { layer = sp.obj.layer; ui.active = layer; App.toast(`SMD pad is on ${LNAME[layer]} — routing on ${LNAME[layer]}`); renderLayers(); syncBar(); }
    if (sp.obj && sp.obj.k === 'track') { layer = sp.obj.layer; ui.active = layer; renderLayers(); syncBar(); }
    const net = sp.obj ? sp.obj.net || null : null;
    ui.route = { net, layer, w: curWidth(net), pts: [[sp.x, sp.y]], done: [], vias: [], startObj: sp.obj, obs: obstacles(layer, net) };
    ui.hlNet = net;
  }
  function addPoints(sp) {
    const R = ui.route, last = R.pts[R.pts.length - 1];
    const o = sp.obj;
    if (o && o.net && R.net && o.net !== R.net) { App.toast(`Can't connect: this ${o.k} is on net ${o.net}, the track is on ${R.net}`); return false; }
    if (o && o.net && !R.net) { R.net = o.net; R.w = curWidth(o.net); R.obs = obstacles(R.layer, R.net); ui.hlNet = o.net; }
    if (o && o.k === 'pad' && !o.p.drill && R.layer !== o.layer) { App.toast(`That SMD pad is on ${LNAME[o.layer]} — right-click (or T / B) to switch layer with a via`); return false; }
    const seg = bend(last, [sp.x, sp.y]), bad = checkClear([last].concat(seg), R.w, R);
    if (bad && !ui.free) { App.toast(`✋ Not placed: ${bad.d <= 0 ? 'it would short' : 'only ' + bad.d.toFixed(3) + ' mm'} to ${bad.what} (needs ${+bad.need.toFixed(3)} mm) — go around it, try the other bend (/) or change layer (right-click)`, 4500); return false; }
    for (const q of seg) R.pts.push(q);
    const same = Math.hypot(sp.x - last[0], sp.y - last[1]) < 1e-6;
    // ending on copper (pad / via / track) finishes the track
    if (o && !(R.startObj && o.k === R.startObj.k && (o.p ? o.p === R.startObj.p : o.i === R.startObj.i) && R.pts.length <= 2)) return finishRoute();
    if (same && R.pts.length > 2) { R.pts.pop(); return finishRoute(); }
    return true;
  }
  function switchLayer(to) {
    const R = ui.route; if (!R) { ui.active = to; return; }
    to = to || (R.layer === 'F' ? 'B' : 'F');
    if (to === R.layer || Pcb.rules().layers === 1) return;
    const p = R.pts[R.pts.length - 1];
    const bad = ui.free ? null : viaProblem(p, R.net);
    if (bad) { App.toast(`✋ No via here: ${bad.d <= 0 ? 'it would short' : 'only ' + bad.d.toFixed(3) + ' mm'} to ${bad.what} (needs ${+bad.need.toFixed(3)} mm) — click a free spot first, then right-click`, 4500); return; }
    if (R.pts.length >= 2) R.done.push({ layer: R.layer, w: R.w, pts: R.pts });
    R.vias.push({ x: p[0], y: p[1] });
    R.layer = to; R.pts = [p]; ui.active = to; ui.layers[to].on = true;
    R.obs = obstacles(to, R.net);
    renderLayers(); syncBar(); render();
  }
  function simplify(pts) {
    const out = [pts[0]];
    for (let k = 1; k < pts.length; k++) {
      const a = out.length > 1 ? out[out.length - 2] : null, b = out[out.length - 1], c = pts[k];
      if (Math.hypot(c[0] - b[0], c[1] - b[1]) < 1e-6) continue;
      if (a && Math.abs((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])) < 1e-9) out[out.length - 1] = c; else out.push(c);
    }
    return out;
  }
  function finishRoute() {
    const R = ui.route; ui.route = null;
    if (!R) return true;
    const parts = R.done.concat(R.pts.length >= 2 ? [{ layer: R.layer, w: R.w, pts: R.pts }] : []);
    if (parts.length || R.vias.length) {
      const R0 = Pcb.rules();
      Model.mutate(() => {
        for (const p of parts) { const pts = simplify(p.pts); if (pts.length >= 2) Model.S.pcb.traces.push({ net: R.net, layer: p.layer, w: +p.w.toFixed(4), pts, manual: true }); }
        for (const v of R.vias) Model.S.pcb.vias.push({ net: R.net, x: v.x, y: v.y, d: R0.viaDiameter, drill: R0.viaDrill, manual: true });
      });
    } else render();
    return true;
  }
  function backspace() {
    const R = ui.route; if (!R) return false;
    if (R.pts.length > 1) R.pts.pop();
    else if (R.done.length) { const d = R.done.pop(); R.vias.pop(); R.layer = d.layer; R.pts = d.pts; ui.active = d.layer; R.obs = obstacles(R.layer, R.net); renderLayers(); syncBar(); }
    else ui.route = null;
    render(); return true;
  }

  // ---------- arcs, copper areas, board outline ----------
  function arcPoints(a, b, m) {
    // circle through a, m, b; sweep from a to b passing m
    const ax = a[0], ay = a[1], bx = b[0], by = b[1], mx = m[0], my = m[1];
    const d = 2 * (ax * (my - by) + mx * (by - ay) + bx * (ay - my));
    if (Math.abs(d) < 1e-6) return [a, b];
    const ux = ((ax * ax + ay * ay) * (my - by) + (mx * mx + my * my) * (by - ay) + (bx * bx + by * by) * (ay - my)) / d;
    const uy = ((ax * ax + ay * ay) * (bx - mx) + (mx * mx + my * my) * (ax - bx) + (bx * bx + by * by) * (mx - ax)) / d;
    const r = Math.hypot(ax - ux, ay - uy), ta = Math.atan2(ay - uy, ax - ux), tm = Math.atan2(my - uy, mx - ux), tb = Math.atan2(by - uy, bx - ux);
    const norm = v => ((v % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    let sweep = norm(tb - ta); if (norm(tm - ta) > sweep) sweep -= 2 * Math.PI;
    const n = Math.max(8, Math.ceil(Math.abs(sweep) * r / 0.4)), out = [];
    for (let k = 0; k <= n; k++) { const t = ta + sweep * k / n; out.push([+(ux + r * Math.cos(t)).toFixed(4), +(uy + r * Math.sin(t)).toFixed(4)]); }
    out[0] = a.slice(); out[n] = b.slice();
    return out;
  }
  function commitArc(m) {
    const A = ui.arc; ui.arc = null; if (!A || !A.b) return;
    const pts = arcPoints(A.a, A.b, m), w = curWidth(A.net);
    Model.mutate(() => Model.S.pcb.traces.push({ net: A.net, layer: A.layer, w, pts, manual: true, arc: true }));
  }
  function closePoly() {
    const P = ui.poly; ui.poly = null; if (!P || P.pts.length < 3) { renderLive(); return; }
    try {
      if (P.kind === 'keepout') {
        const r = Model.mutate(() => Pcb.addKeepout({ points: P.pts, layer: 'both' }));
        ui.sel = null; ui.item = { k: 'ko', i: r.index }; ui.hlNet = null; ui.onSelect(null);
        App.toast(r.already_inside.length ? `Keep-out added — ${r.already_inside.length} problems inside: press Route to move the copper out` : 'Keep-out added: the router and copper pours avoid it (settings in Properties)', 7000);
      } else if (P.kind === 'outline') {
        Model.mutate(() => Pcb.setBoardShape({ shape: 'polygon', points: P.pts, corner_radius: ui.outlineR || 0 }));
        App.toast('Board outline updated — press Route to re-check connections'); setTool('select'); Pcb.fit && fit();
      } else {
        const S = Model.S, net = P.net || (S.nets.GND ? 'GND' : Object.keys(S.nets)[0]);
        Model.mutate(() => Pcb.addPour({ net, layer: ui.active, points: P.pts }));
        ui.item = { k: 'pour', i: S.pcb.pours.length - 1 }; ui.hlNet = net; ui.onSelect(null);
        App.toast(`Copper area on ${LNAME[ui.active]} for net ${net} — change the net in Properties`);
      }
    } catch (e) { App.toast(e.message); }
    render();
  }

  // ---------- mouse ----------
  let drag = null, pan = null, rdown = null;
  // part selection: ui.sel is the primary part (Properties), ui.multi every selected part
  const isSel = ref => ui.sel === ref || ui.multi.has(ref);
  function selected() { if (!ui.sel) return []; const r = ui.multi.size ? [...ui.multi] : [ui.sel]; return r.filter(x => { const c = Model.comp(x); return c && c.pcb; }); }
  function setSelection(refs) { ui.multi = new Set(refs); ui.sel = refs[0] || null; ui.item = null; ui.hlNet = null; ui.onSelect(ui.sel); render(); }
  function drawBox() {
    const b = ui.box; if (!b) { boxEl.style.display = 'none'; return; }
    boxEl.style.display = ''; boxEl.setAttribute('x', Math.min(b.x0, b.x1)); boxEl.setAttribute('y', Math.min(b.y0, b.y1));
    boxEl.setAttribute('width', Math.abs(b.x1 - b.x0)); boxEl.setAttribute('height', Math.abs(b.y1 - b.y0));
  }
  function down(e) {
    const pt = vp.toWorld(e.clientX, e.clientY);
    if (e.button === 2) { const el = e.target.closest('[data-ref],[data-pref]'); rdown = { x: e.clientX, y: e.clientY, ref: el ? el.dataset.ref || el.dataset.pref : null }; pan = { x: e.clientX, y: e.clientY }; e.preventDefault(); return; }
    if (e.button === 1) { pan = { x: e.clientX, y: e.clientY }; e.preventDefault(); return; }
    if (ui.tool === 'track') {
      const sp = snapPoint(pt, ui.route ? ui.route.layer : null);
      if (!ui.route) startRoute(sp); else addPoints(sp);
      render(); coord(); return;
    }
    if (ui.tool === 'arc') {
      const sp = snapPoint(pt, null);
      if (!ui.arc) { const o = sp.obj; ui.arc = { a: [sp.x, sp.y], net: o ? o.net || null : null, layer: o && o.layer ? o.layer : ui.active }; }
      else if (!ui.arc.b) { if (sp.obj && sp.obj.net && !ui.arc.net) ui.arc.net = sp.obj.net; ui.arc.b = [sp.x, sp.y]; }
      else commitArc([pt.x, pt.y]);
      renderLive(); return;
    }
    if (ui.tool === 'pour' || ui.tool === 'outline' || ui.tool === 'keepout') {
      const sp = ui.tool === 'pour' ? snapPoint(pt, null) : { x: +snapG(pt.x).toFixed(3), y: +snapG(pt.y).toFixed(3), obj: null };
      if (!ui.poly) ui.poly = { kind: ui.tool, pts: [], net: sp.obj && sp.obj.net };
      const P = ui.poly.pts, f = P[0];
      if (P.length >= 3 && Math.hypot(sp.x - f[0], sp.y - f[1]) < Math.max(0.5, 8 / vp.s)) closePoly();
      else P.push([sp.x, sp.y]);
      renderLive(); return;
    }
    if (ui.tool === 'text') {
      const t = prompt('Text on the ' + (ui.active === 'B' ? 'bottom' : 'top') + ' silkscreen', ''); if (t === null || !t.trim()) return;
      const r = Model.mutate(() => Pcb.addText({ text: t.trim(), x: +snapG(pt.x).toFixed(3), y: +snapG(pt.y).toFixed(3), side: ui.active === 'B' ? 'bottom' : 'top' }));
      setTool('select'); ui.sel = null; ui.item = { k: 'txt', i: r.index }; ui.onSelect(null); render(); return;
    }
    if (ui.tool === 'via') {
      const sp = snapPoint(pt, null), R0 = Pcb.rules();
      if (Pcb.rules().layers === 1) { App.toast('Single-layer rules: vias are disabled'); return; }
      const bad = ui.free ? null : viaProblem([sp.x, sp.y], sp.obj ? sp.obj.net || null : null, R0);
      if (bad) { App.toast(`✋ No via here: ${bad.d <= 0 ? 'it would short' : 'only ' + bad.d.toFixed(3) + ' mm'} to ${bad.what} (needs ${+bad.need.toFixed(3)} mm)`, 4500); return; }
      Model.mutate(() => Model.S.pcb.vias.push({ net: sp.obj ? sp.obj.net || null : null, x: sp.x, y: sp.y, d: R0.viaDiameter, drill: R0.viaDrill, manual: true }));
      return;
    }
    if (ui.tool === 'measure') {
      const sp = snapPoint(pt, null);
      if (!ui.measure || ui.measure.done) ui.measure = { a: [sp.x, sp.y], b: [sp.x, sp.y], done: false };
      else { ui.measure.b = [sp.x, sp.y]; ui.measure.done = true; }
      render(); return;
    }
    // select
    const el = e.target.closest('[data-k],[data-ref]');
    ui.hlAt = [pt.x, pt.y];
    if (el && el.dataset.k === 't') {
      const i = +el.dataset.i, sg = +el.dataset.s, t = Model.S.pcb.traces[i];
      // grab a corner if the click is on one, otherwise the whole segment
      const near = [sg - 1, sg].find(k => Math.hypot(t.pts[k][0] - pt.x, t.pts[k][1] - pt.y) <= Math.max(t.w * 0.7, 6 / vp.s));
      selectItem({ k: 't', i, s: sg });
      drag = { kind: near != null ? 'vertex' : 'seg', i, s: sg, v: near, orig: t.pts.map(q => q.slice()), x0: pt.x, y0: pt.y, moved: false };
      return;
    }
    if (el && el.dataset.k === 'ko') { ui.sel = null; ui.multi = new Set(); ui.item = { k: 'ko', i: +el.dataset.i }; ui.hlNet = null; ui.onSelect(null); render(); return; }
    if (el && el.dataset.k === 'pour') { ui.sel = null; ui.item = { k: 'pour', i: +el.dataset.i }; ui.hlNet = (Model.S.pcb.pours[+el.dataset.i] || {}).net; ui.onSelect(null); render(); pan = { x: e.clientX, y: e.clientY }; return; }
    if (el && el.dataset.k === 'h') { const h = Model.S.pcb.holes[+el.dataset.i]; ui.sel = null; ui.item = { k: 'h', i: +el.dataset.i }; ui.hlNet = null; ui.onSelect(null); drag = { kind: 'hole', i: +el.dataset.i, ox: pt.x - h.x, oy: pt.y - h.y, moved: false }; render(); return; }
    if (el && el.dataset.k === 'v') { const v = Model.S.pcb.vias[+el.dataset.i]; selectItem({ k: 'v', i: +el.dataset.i }); drag = { kind: 'via', i: +el.dataset.i, ox: pt.x - v.x, oy: pt.y - v.y, moved: false }; drag.ends = viaEnds(v); return; }
    if (el && el.dataset.k === 'lsize') {
      const cx = +el.dataset.cx, cy = +el.dataset.cy;
      drag = { kind: 'lsize', lk: el.dataset.lk, ref: el.dataset.lref, i: +el.dataset.i, cx, cy, h0: +el.dataset.h, d0: Math.max(0.2, Math.hypot(pt.x - cx, pt.y - cy)), moved: false }; return;
    }
    if (el && el.dataset.k === 'lbl' && !(el.dataset.lk === 'part' && Model.comp(el.dataset.lref) && !partVisible(Model.comp(el.dataset.lref)))) {
      const lk = el.dataset.lk, cx = +el.dataset.cx, cy = +el.dataset.cy;
      if (lk === 'part') { const c = Model.comp(el.dataset.lref); ui.item = null; ui.multi = new Set([c.ref]); ui.sel = c.ref; ui.labelOf = c.ref; ui.hlNet = null; ui.onSelect(c.ref); }
      else { ui.sel = null; ui.multi = new Set(); ui.hlNet = null; ui.item = lk === 'board' ? { k: 'blbl' } : { k: 'txt', i: +el.dataset.i }; ui.onSelect(null); }
      drag = { kind: 'label', lk, ref: el.dataset.lref, i: +el.dataset.i, ox: pt.x - cx, oy: pt.y - cy, moved: false }; render(); return;
    }
    let ref = el && (el.dataset.ref || el.dataset.pref);
    if (ref && Model.comp(ref) && !partVisible(Model.comp(ref))) ref = null;   // its side is hidden
    ui.labelOf = null;   // clicking anything but a label: R / + / − act on parts again
    if (ref) {
      const c = Model.comp(ref); ui.item = null;
      if (e.shiftKey || e.ctrlKey || e.metaKey) { // add to / remove from the selection
        const m = new Set(selected()); if (m.has(c.ref)) m.delete(c.ref); else m.add(c.ref);
        setSelection([...m].sort((a, b) => (a === c.ref ? -1 : b === c.ref ? 1 : 0))); return;
      }
      if (!(ui.multi.size > 1 && ui.multi.has(c.ref))) ui.multi = new Set([c.ref]);   // otherwise keep the group
      ui.sel = c.ref; ui.hlNet = el.dataset.net || null; ui.onSelect(c.ref);
      drag = { kind: 'fp', x0: pt.x, y0: pt.y, orig: selected().map(r => { const o = Model.comp(r); return [o, o.pcb.x, o.pcb.y]; }), moved: false }; render();
      drag.ends = attachedEnds(drag.orig.map(o => o[0].ref)); return;
    }
    // drag on empty space: selection box (Shift adds to the selection)
    const keep = e.shiftKey ? selected() : [];
    if (!e.shiftKey) { ui.sel = null; ui.multi = new Set(); }
    ui.item = null; ui.hlNet = null; ui.onSelect(ui.sel); render();
    ui.box = { x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y, add: keep }; drawBox();
  }
  // the silkscreen text that is selected: a free text, the board name, or (with a part selected) that part's label
  function selectedLabel() {
    if (ui.item && ui.item.k === 'txt') return { lk: 'text', i: ui.item.i };
    if (ui.item && ui.item.k === 'blbl') return { lk: 'board' };
    if (ui.labelOf && !ui.item && ui.sel === ui.labelOf) return { lk: 'part', ref: ui.sel };
    return null;
  }
  const labelSelected = l => { const s = selectedLabel(); return !!s && s.lk === l.kind && (l.kind === 'part' ? s.ref === l.ref : l.kind === 'text' ? s.i === l.i : true); };
  function setLabel(t, o) { if (t.lk === 'part') Pcb.setSilkLabel(t.ref, o); else if (t.lk === 'board') Pcb.setSilkLabel('board', o); else Pcb.updateText(t.i, o); }
  // the selected net at a glance: the whole route glows, its vias and pads get rings, the parts on it are outlined,
  // and a tag shows the net name, pads / parts and the routed length
  function netInfo(net) {
    const S = Model.S, tr = S.pcb.traces.filter(t => t.net === net);
    let len = 0; for (const t of tr) for (let i = 1; i < t.pts.length; i++) len += Math.hypot(t.pts[i][0] - t.pts[i - 1][0], t.pts[i][1] - t.pts[i - 1][1]);
    const pads = cache.pads.filter(p => p.net === net), refs = [...new Set(pads.map(p => p.ref))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return { tr, vias: S.pcb.vias.filter(v => v.net === net), pads, refs, len };
  }
  function netHighlight(net) {
    const n = netInfo(net), o = [], g = 1 / vp.s;   // g: one screen pixel in mm
    o.push('<g class="nethl" pointer-events="none">');
    for (const t of n.tr) o.push(`<polyline points="${t.pts.map(q => q.join(',')).join(' ')}" fill="none" stroke="#ffe14a" stroke-opacity="0.55" stroke-width="${t.w + 6 * g}" stroke-linecap="round" stroke-linejoin="round"/>`);
    for (const v of n.vias) o.push(`<circle cx="${v.x}" cy="${v.y}" r="${v.d / 2 + 2 * g}" fill="none" stroke="#ffe14a" stroke-width="${2.5 * g}"/>`);
    for (const p of n.pads) o.push(p.shape === 'round' ? `<circle cx="${p.x}" cy="${p.y}" r="${p.w / 2 + 2 * g}" fill="none" stroke="#ffe14a" stroke-width="${2.5 * g}"/>` : `<rect x="${p.x - p.w / 2 - 2 * g}" y="${p.y - p.h / 2 - 2 * g}" width="${p.w + 4 * g}" height="${p.h + 4 * g}" fill="none" stroke="#ffe14a" stroke-width="${2.5 * g}"/>`);
    for (const r of n.refs) { const c = Model.comp(r); if (!c || !c.pcb) continue; const b = Pcb.fpBox(c, 0.25); o.push(`<rect x="${b[0]}" y="${b[1]}" width="${b[2] - b[0]}" height="${b[3] - b[1]}" fill="none" stroke="#ffe14a" stroke-width="${2 * g}" stroke-dasharray="${6 * g} ${4 * g}"/>`); }
    // name tag at the picked point (constant size on screen)
    const at = ui.hlAt || (n.pads[0] ? [n.pads[0].x, n.pads[0].y] : null);
    if (at) {
      const fs = 13 * g, line2 = `${n.pads.length} pads · ${n.refs.length} parts · ${n.len.toFixed(1)} mm routed`, w = Math.max(net.length * fs * 0.62, line2.length * fs * 0.48) + 12 * g, x = at[0] + 12 * g, y = at[1] - 46 * g;
      o.push(`<rect x="${x}" y="${y}" width="${w}" height="${36 * g}" rx="${5 * g}" fill="#111827" fill-opacity="0.92" stroke="#ffe14a" stroke-width="${1.5 * g}"/>`);
      o.push(`<text x="${x + 6 * g}" y="${y + 15 * g}" fill="#ffe14a" style="font:700 ${fs}px sans-serif">${esc(net)}</text>`);
      o.push(`<text x="${x + 6 * g}" y="${y + 29 * g}" fill="#e5e7eb" style="font:${fs * 0.8}px sans-serif">${esc(line2)}</text>`);
    }
    o.push('</g>');
    return o.join('');
  }
  function selectItem(it) {
    ui.sel = null; ui.item = it;
    const S = Model.S; ui.hlNet = it.k === 'v' ? S.pcb.vias[it.i].net : S.pcb.traces[it.i].net;
    ui.onSelect(null); render();
  }
  function dbl(e) {
    if (ui.tool === 'select') { const el = e.target.closest('[data-k="t"]'); if (el) selectItem({ k: 'T', i: +el.dataset.i }); }
    else if (ui.tool === 'track' && ui.route) finishRoute();
  }
  function move(e) {
    if (!svg || svg.classList.contains('hidden')) return;
    if (pan) { vp.panBy(e.clientX - pan.x, e.clientY - pan.y); pan = { x: e.clientX, y: e.clientY }; return; }
    const pt = vp.toWorld(e.clientX, e.clientY);
    if (ui.box) { ui.box.x1 = pt.x; ui.box.y1 = pt.y; drawBox(); return; }
    if (drag) {
      if (drag.kind === 'fp') {
        const g = Math.max(ui.grid, 0.05), dx = Math.round((pt.x - drag.x0) / g) * g, dy = Math.round((pt.y - drag.y0) / g) * g, [c0, x0, y0] = drag.orig[0] || [];
        if (c0 && c0.pcb && (Math.abs(c0.pcb.x - (x0 + dx)) > 1e-6 || Math.abs(c0.pcb.y - (y0 + dy)) > 1e-6)) {
          if (!drag.moved) { Model.begin(); drag.moved = true; }
          for (const [c, x, y] of drag.orig) if (c.pcb) { c.pcb.x = +(x + dx).toFixed(4); c.pcb.y = +(y + dy).toFixed(4); }
          for (const t of drag.ends) { const tr = Model.S.pcb.traces[t.i]; if (tr) for (const k of t.ks) tr.pts[k] = [+(t.orig[k][0] + dx).toFixed(4), +(t.orig[k][1] + dy).toFixed(4)]; }
          dragFast(drag, dx, dy);
        }
      } else if (drag.kind === 'seg' || drag.kind === 'vertex') {
        const t = Model.S.pcb.traces[drag.i]; if (!t) return;
        const dx = snapG(pt.x - drag.x0), dy = snapG(pt.y - drag.y0); if (!dx && !dy && !drag.moved) return;
        if (!drag.moved) { Model.begin(); drag.moved = true; }
        const o = drag.orig.map(q => q.slice()), mv = k => { o[k] = [+(o[k][0] + dx).toFixed(4), +(o[k][1] + dy).toFixed(4)]; };
        if (drag.kind === 'vertex') { mv(drag.v); t.pts = o; }
        else {
          // move both ends of the segment; keep the track attached where it started / ended by inserting a new corner
          const a = drag.s - 1, b = drag.s; mv(a); mv(b);
          if (b === o.length - 1) o.push(drag.orig[b].slice());
          if (a === 0) o.unshift(drag.orig[0].slice());
          t.pts = o;
        }
        Model.emit('move');
      } else if (drag.kind === 'hole') {
        const h = Model.S.pcb.holes[drag.i], nx = +snapG(pt.x - drag.ox).toFixed(3), ny = +snapG(pt.y - drag.oy).toFixed(3);
        if (nx !== h.x || ny !== h.y) { if (!drag.moved) { Model.begin(); drag.moved = true; } h.x = nx; h.y = ny; h.auto = false; Model.emit('move'); }
      } else if (drag.kind === 'lsize') {
        const h = Math.max(0.6, Math.min(10, Math.round(drag.h0 * Math.hypot(pt.x - drag.cx, pt.y - drag.cy) / drag.d0 * 10) / 10));
        if (!drag.moved) { Model.begin(); drag.moved = true; }
        setLabel(drag, { size: h }); Model.emit('move');
      } else if (drag.kind === 'label') {
        const nx = +snapG(pt.x - drag.ox).toFixed(3), ny = +snapG(pt.y - drag.oy).toFixed(3);
        if (!drag.moved) { Model.begin(); drag.moved = true; }
        if (drag.lk === 'part') Pcb.setSilkLabel(drag.ref, { x: nx, y: ny }); else if (drag.lk === 'board') Pcb.setSilkLabel('board', { x: nx, y: ny }); else Pcb.updateText(drag.i, { x: nx, y: ny });
        Model.emit('move');
      } else if (drag.kind === 'via') {
        const v = Model.S.pcb.vias[drag.i], nx = +snapG(pt.x - drag.ox).toFixed(4), ny = +snapG(pt.y - drag.oy).toFixed(4);
        if (nx !== v.x || ny !== v.y) {
          if (!drag.moved) { Model.begin(); drag.moved = true; }
          v.x = nx; v.y = ny;
          for (const [ti, k] of drag.ends || []) { const t = Model.S.pcb.traces[ti]; if (t) t.pts[k] = [nx, ny]; }   // the tracks on the via follow it
          Model.emit('move');
        }
      }
      return;
    }
    if (!svg.matches(':hover') && !ui.route) return;
    ui.cursor = (ui.tool === 'track' || ui.tool === 'via' || ui.tool === 'measure') ? snapPoint(pt, ui.route ? ui.route.layer : null) : { x: pt.x, y: pt.y };
    if (ui.measure && !ui.measure.done) ui.measure.b = [ui.cursor.x, ui.cursor.y];
    if (ui.tool !== 'select') renderLive();
    coord();
  }
  function up(e) {
    if (ui.box) {
      const b = ui.box, x0 = Math.min(b.x0, b.x1), x1 = Math.max(b.x0, b.x1), y0 = Math.min(b.y0, b.y1), y1 = Math.max(b.y0, b.y1);
      ui.box = null; drawBox();
      if (x1 - x0 > 0.2 || y1 - y0 > 0.2) {
        const hit = Pcb.placed().filter(partVisible).filter(c => { const q = Pcb.fpBox(c); return q[0] < x1 && q[2] > x0 && q[1] < y1 && q[3] > y0; }).map(c => c.ref);
        setSelection([...new Set([...b.add, ...hit])]);
      } else if (!b.add.length) drag = { kind: 'box' };
    }
    if (drag && drag.kind === 'box') {   // a click (no drag) on empty board: the copper pour under it, if any
      const pt = vp.toWorld(e.clientX, e.clientY), P = Model.S.pcb.pours || [];
      for (const L of [ui.active, ui.active === 'F' ? 'B' : 'F']) {
        const i = P.findIndex(pr => pr.layer === L && vis(L) && Pcb.inPoly(pt.x, pt.y, Pcb.pourPoly(pr)));
        if (i >= 0) { ui.item = { k: 'pour', i }; ui.hlNet = P[i].net; ui.onSelect(null); render(); break; }
      }
    }
    if (rdown && e.button === 2) {
      const moved = Math.hypot(e.clientX - rdown.x, e.clientY - rdown.y) > 4, r = rdown; rdown = null;
      if (!moved) {
        if (ui.route) switchLayer(); else if (ui.tool !== 'select') setTool('select');   // routing: right-click = via + other layer
        else { // context menu
          if (r.ref && !isSel(r.ref)) setSelection([r.ref]);
          ui.mouse = vp.toWorld(e.clientX, e.clientY);
          ui.onContext({ x: e.clientX, y: e.clientY, ref: r.ref });
        }
      }
    }
    if (drag && drag.moved) Model.emit('change');
    drag = null; pan = null;
  }

  // ---------- keyboard ----------
  function key(e) {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k === 'w') { setTool('track'); return true; }
    if (k === 'v') { if (ui.route) switchLayer(); else setTool('via'); return true; }
    if (k === 'm') { setTool('measure'); return true; }
    if (k === 't' && !e.ctrlKey && !e.metaKey) { setTool('text'); return true; }
    if (k === 'a') { setTool('arc'); return true; }
    if (k === 'e') { setTool('pour'); return true; }
    if (k === 'k') { setTool('keepout'); return true; }
    if (k === 'Enter' && ui.poly) { closePoly(); return true; }
    if (k === 's') { setTool('select'); return true; }
    if (k === 't' || k === 'b') { const to = k === 't' ? 'F' : 'B'; if (ui.route) switchLayer(to); else { ui.active = to; ui.layers[to].on = true; renderLayers(); syncBar(); render(); } return true; }
    if (k === 'l') { const to = ui.active === 'F' ? 'B' : 'F'; if (ui.route) switchLayer(to); else { ui.active = to; renderLayers(); syncBar(); render(); } return true; }
    if (k === ' ') { ui.angle = ui.angle === '45' ? '90' : ui.angle === '90' ? 'any' : '45'; persist(); syncBar(); renderLive(); App.toast('Routing angle: ' + (ui.angle === 'any' ? 'any' : ui.angle + '°')); return true; }
    if (k === '/') { ui.flip = !ui.flip; renderLive(); return true; }
    if (k === 'Backspace' && ui.route) return backspace();
    if (k === 'Escape' && (ui.arc || ui.poly)) { ui.arc = null; ui.poly = null; renderLive(); return true; }
    if (k === 'Backspace' && ui.poly) { ui.poly.pts.pop(); if (!ui.poly.pts.length) ui.poly = null; renderLive(); return true; }
    if (k === 'Escape') { if (ui.route) finishRoute(); else if (ui.measure) { ui.measure = null; render(); } else if (ui.tool !== 'select') setTool('select'); else { ui.sel = null; ui.item = null; ui.hlNet = null; ui.onSelect(null); render(); } return true; }
    if ((k === 'Delete' || k === 'Backspace') && ui.item) { deleteItem(); return true; }
    const lt = selectedLabel();
    if (lt && (k === 'r' || k === '+' || k === '=' || k === '-')) {
      const l = Pcb.silkInfo().find(x => x.kind === lt.lk && (lt.lk === 'part' ? x.ref === lt.ref : lt.lk === 'text' ? x.index === lt.i : true));
      if (l) Model.mutate(() => setLabel(lt, k === 'r' ? { rotation: ((l.rotation || 0) + (e.shiftKey ? 270 : 90)) % 360 } : { size: Math.max(0.6, Math.round((l.size + (k === '-' ? -0.2 : 0.2)) * 10) / 10) }));
      return true;
    }
    if (k === 'r' && selected().length) { rotate(); return true; }
    if ((k === 'Delete' || k === 'Backspace') && selected().length) { del(); return true; }
    if ((k === '+' || k === '=' || k === '-') && ui.tool === 'track') { const w = Math.max(0.05, +((ui.width || curWidth(ui.route && ui.route.net)) + (k === '-' ? -0.05 : 0.05)).toFixed(3)); ui.width = w; $('#pWidth').value = w; if (ui.route) ui.route.w = w; renderLive(); coord(); return true; }
    return false;
  }
  function rotate() { const refs = selected(); Model.mutate(() => { for (const r of refs) { const c = Model.comp(r); c.pcb.rot = ((c.pcb.rot || 0) + 90) % 360; } }); }
  // a part is one object in schematic and PCB: deleting it on the board removes it from the design
  function del() { const refs = selected(); ui.sel = null; ui.multi = new Set(); ui.onSelect(null); Model.mutate(() => { for (const r of refs) if (Model.comp(r)) Model.removeComponent(r); }); }
  function flip() { const refs = selected(); Model.mutate(() => { for (const r of refs) Pcb.placeFootprint(r, { side: Pcb.isBottom(Model.comp(r)) ? 'top' : 'bottom' }); }); }
  const selectAll = () => setSelection(Pcb.placed().map(c => c.ref));
  function deleteItem() {
    const it = ui.item; if (!it) return; ui.item = null; ui.hlNet = null;
    Model.mutate(() => {
      const S = Model.S;
      if (it.k === 'v') S.pcb.vias.splice(it.i, 1);
      else if (it.k === 'pour') S.pcb.pours.splice(it.i, 1);
      else if (it.k === 'ko') Pcb.removeKeepout({ index: it.i });
      else if (it.k === 'h') S.pcb.holes.splice(it.i, 1);
      else if (it.k === 'txt') Pcb.removeText(it.i);
      else if (it.k === 'blbl') Pcb.setSilkLabel('board', { hidden: true });
      else if (it.k === 'T') S.pcb.traces.splice(it.i, 1);
      else if (it.k === 't') {
        const t = S.pcb.traces[it.i], a = t.pts.slice(0, it.s), b = t.pts.slice(it.s);
        const keep = []; if (a.length >= 2) keep.push(Object.assign({}, t, { pts: a })); if (b.length >= 2) keep.push(Object.assign({}, t, { pts: b }));
        S.pcb.traces.splice(it.i, 1, ...keep);
      }
    });
  }

  // ---------- rendering ----------
  // data-o: the part an element belongs to — a part drag moves just those elements (see dragFast)
  const padEl = (p, fill, extra = '', grow = 0) => p.shape === 'round'
    ? `<circle data-o="${esc(p.ref)}" cx="${p.x}" cy="${p.y}" r="${p.w / 2 + grow}" fill="${fill}" ${extra}/>`
    : `<rect data-o="${esc(p.ref)}" x="${p.x - p.w / 2 - grow}" y="${p.y - p.h / 2 - grow}" width="${p.w + 2 * grow}" height="${p.h + 2 * grow}" rx="${p.shape === 'oval' ? Math.min(p.w, p.h) / 2 + grow : 0}" fill="${fill}" ${extra}/>`;
  function render() {
    if (!world) return;
    const S = Model.S, cs = Pcb.placed();
    cache.pads = allPads();
    if (!cs.length || !S.board.w) { world.innerHTML = '<text x="0" y="0" text-anchor="middle" fill="#888" style="font-size:2.4px">No PCB yet — click “Generate PCB”, or ask the Copilot to make the board</text>'; renderLiveLayer(); return; }
    const out = [], hl = ui.hlNet;
    svg.classList.toggle('hlmode', !!hl);   // highlighted net: everything else is dimmed
    // footprint hit areas (bottom), so copper on top stays clickable
    for (const c of cs) { if (!partVisible(c)) continue; const b = Pcb.fpBox(c); out.push(`<rect class="fphit" data-ref="${esc(c.ref)}" data-o="${esc(c.ref)}" x="${b[0]}" y="${b[1]}" width="${b[2] - b[0]}" height="${b[3] - b[1]}"/>`); }
    const R0 = Pcb.rules(), bpoly = Pcb.boardPoly(), bpath = 'M' + bpoly.map(q => q.join(' ')).join('L') + 'Z';
    out.push(`<defs><clipPath id="bclip"><path d="${bpath}"/></clipPath><pattern id="kohatch" width="0.8" height="0.8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="0.8" stroke="#ff5a5a" stroke-width="0.12"/></pattern></defs>`);
    const order = ui.active === 'F' ? ['B', 'F'] : ['F', 'B'];
    for (const L of order) {
      if (!vis(L)) continue;
      const op = ui.dim && L !== ui.active ? 0.45 : 0.9, c = col(L);
      // copper pours: filled polygon with other nets' copper (+ clearance) and the edge band masked out
      (S.pcb.pours || []).forEach((pr, i) => {
        if (pr.layer !== L) return;
        const cl = Pcb.pourCl(R0, pr), poly = Pcb.pourPoly(pr), m = [];
        m.push(`<rect x="-50" y="-50" width="${S.board.w + 100}" height="${S.board.h + 100}" fill="white"/>`);
        for (const t of S.pcb.traces) if (t.layer === L && t.net !== pr.net) m.push(`<polyline points="${t.pts.map(q => q.join(',')).join(' ')}" fill="none" stroke="black" stroke-width="${t.w + 2 * cl}" stroke-linecap="round" stroke-linejoin="round"/>`);
        for (const p of cache.pads) if (p.net !== pr.net && padLayers(p).includes(L)) m.push(padEl(p, 'black', '', cl));
        for (const v of S.pcb.vias) if (v.net !== pr.net) m.push(`<circle cx="${v.x}" cy="${v.y}" r="${v.d / 2 + cl}" fill="black"/>`);
        m.push(`<path d="${bpath}" fill="none" stroke="black" stroke-width="${2 * R0.edgeClearance}"/>`);
        for (const k of Pcb.keepouts()) if (k.pours && (k.layer === 'both' || k.layer === L)) m.push(`<path d="M${k.pts.map(q => q.join(' ')).join('L')}Z" fill="black"/>`);
        out.push(`<defs><mask id="pm${i}" maskUnits="userSpaceOnUse" x="-50" y="-50" width="${S.board.w + 100}" height="${S.board.h + 100}">${m.join('')}</mask></defs>`);
        const sel = ui.item && ui.item.k === 'pour' && ui.item.i === i;
        // only the live pieces (as in the Gerber), with the clearance around other nets' copper masked out
        let fd; try { fd = Pcb.pourFill(pr, 'view').rings.map(rg => 'M' + rg.pts.map(q => q.join(' ')).join('L') + 'Z').join(''); } catch (e) { fd = 'M' + poly.map(q => q.join(' ')).join('L') + 'Z'; }
        out.push(`<path data-k="pour" data-i="${i}" class="pour${hl && pr.net === hl ? ' hl' : ''}" pointer-events="none" d="${fd || 'M0 0'}" fill-rule="evenodd" fill="${c}" fill-opacity="${sel ? 0.55 : 0.38}" mask="url(#pm${i})" clip-path="url(#bclip)" opacity="${op}"><title>Copper area · ${esc(pr.net)} · ${LNAME[L]}</title></path>`);
        if (sel) out.push(`<path d="M${poly.map(q => q.join(' ')).join('L')}Z" class="selbox" />`);
      });
      out.push(`<g class="cu" opacity="${op}">`);
      S.pcb.traces.forEach((t, i) => {
        if (t.layer !== L) return;
        for (let s = 1; s < t.pts.length; s++) out.push(`<line data-k="t" data-i="${i}" data-s="${s}" class="trk${hl && t.net === hl ? ' hl' : ''}" x1="${t.pts[s - 1][0]}" y1="${t.pts[s - 1][1]}" x2="${t.pts[s][0]}" y2="${t.pts[s][1]}" stroke="${c}" stroke-width="${t.w}"><title>${esc(t.net || '(no net)')} · ${t.w} mm · ${LNAME[t.layer]}</title></line>`);
      });
      for (const p of cache.pads) if (!p.drill && (p.layer || 'F') === L) out.push(padEl(p, c, `class="pad${hl && p.net === hl ? ' hl' : ''}" data-pref="${esc(p.ref)}" data-net="${esc(p.net || '')}"><title>${esc(p.key)}${p.net ? ' · ' + esc(p.net) : ''}</title></${p.shape === 'round' ? 'circle' : 'rect'}`).replace(/\/><\/(circle|rect)$/, ''));
      out.push('</g>');
    }
    if (vis('MU')) {
      for (const p of cache.pads) if (p.drill) out.push(padEl(p, col('MU'), `class="pad${hl && p.net === hl ? ' hl' : ''}" data-pref="${esc(p.ref)}" data-net="${esc(p.net || '')}"`).replace('/>', `><title>${esc(p.key)}${p.net ? ' · ' + esc(p.net) : ''}</title></${p.shape === 'round' ? 'circle' : 'rect'}>`));
      S.pcb.vias.forEach((v, i) => out.push(`<circle data-k="v" data-i="${i}" class="via${hl && v.net === hl ? ' hl' : ''}" cx="${v.x}" cy="${v.y}" r="${v.d / 2}" fill="${col('MU')}"><title>via ${esc(v.net || '(no net)')} · ${v.d}/${v.drill} mm</title></circle>`));
    }
    (S.pcb.holes || []).forEach((h, i) => {
      if (!vis('HO') && !vis('MU')) return;
      out.push(`<g data-k="h" data-i="${i}" class="mhole"><circle cx="${h.x}" cy="${h.y}" r="${h.d / 2 + R0.clearance}" fill="none" stroke="${col('MU')}" stroke-width="0.08" stroke-dasharray="0.3 0.2"/><circle cx="${h.x}" cy="${h.y}" r="${h.d / 2}" fill="${col('HO')}" stroke="${col('MU')}" stroke-width="0.1"><title>Mounting hole Ø${h.d} mm (non-plated)</title></circle></g>`);
    });
    if (vis('HO')) {
      for (const p of cache.pads) if (p.drill) out.push(`<circle data-o="${esc(p.ref)}" cx="${p.x}" cy="${p.y}" r="${p.drill / 2}" fill="${col('HO')}" pointer-events="none"/>`);
      for (const v of S.pcb.vias) out.push(`<circle cx="${v.x}" cy="${v.y}" r="${v.drill / 2}" fill="${col('HO')}" pointer-events="none"/>`);
    }
    if (vis('FM')) for (const p of cache.pads) if (p.drill || (p.layer || 'F') === 'F') out.push(padEl(p, 'none', `stroke="${col('FM')}" stroke-width="0.05" pointer-events="none"`, 0.05));
    if (vis('BM')) for (const p of cache.pads) if (p.drill || p.layer === 'B') out.push(padEl(p, 'none', `stroke="${col('BM')}" stroke-width="0.05" stroke-dasharray="0.2 0.1" pointer-events="none"`, 0.05));
    for (const c of cs) {
      const sl = Pcb.isBottom(c) ? 'BS' : 'FS'; if (!vis(sl)) continue;
      const b = Pcb.fpBox(c);
      out.push(`<rect data-o="${esc(c.ref)}" x="${b[0]}" y="${b[1]}" width="${b[2] - b[0]}" height="${b[3] - b[1]}" fill="none" stroke="${col(sl)}" stroke-width="0.15" pointer-events="none"/>`);
    }
    // silkscreen text exactly as exported (part labels, board name, free text); drag to move, red = covers pads
    const lblHits = [];
    for (const [side, sl] of [['F', 'FS'], ['B', 'BS']]) {
      if (!vis(sl)) continue;
      for (const l of Pcb.silkLabels(side)) {
        const r = l.rect, [cx, cy] = Pcb.labelCentre(l), on = labelSelected(l);
        out.push(`<path ${l.kind === 'part' ? `data-o="${esc(l.ref)}" ` : ''}d="${l.lines.map(pl => 'M' + pl.map(q => q.join(' ')).join('L')).join('')}" fill="none" stroke="${col(sl)}" stroke-width="${l.w}" stroke-linecap="round" stroke-linejoin="round" pointer-events="none"/>`);
        const data = `data-lk="${l.kind}" data-lref="${esc(l.ref || '')}" data-i="${l.i != null ? l.i : ''}" data-cx="${cx}" data-cy="${cy}" data-h="${l.h}"`;
        lblHits.push(`<rect ${l.kind === 'part' ? `data-o="${esc(l.ref)}" ` : ''}class="lblhit${on ? ' on' : ''}${l.overPads ? ' bad' : ''}" data-k="lbl" ${data} x="${r[0]}" y="${r[1]}" width="${r[2] - r[0]}" height="${r[3] - r[1]}"><title>${esc(l.kind === 'part' ? l.ref + ' label' : l.kind === 'board' ? 'Board name' : 'Text')}${l.overPads ? ' — covers pads, move it' : ''} · drag to move · R rotates · + / − size</title></rect>`);
        // resize handle on the selected text: drag it away from / towards the centre
        if (on) { const hs = Math.max(0.35, 7 / vp.s); lblHits.push(`<rect class="lblsize" data-k="lsize" ${data} x="${r[2] - hs / 2}" y="${r[1] - hs / 2}" width="${hs}" height="${hs}"><title>Drag to resize</title></rect>`); }
      }
    }
    if (vis('OL')) out.push(`<path d="${bpath}" fill="none" stroke="${col('OL')}" stroke-width="0.15" pointer-events="none"/>`);
    // flex stiffeners: dashed purple outlines
    const fx = S.pcb.flex; if (fx && fx.on) for (const st of fx.stiffeners || []) out.push(`<path d="M${st.pts.map(q => q.join(' ')).join('L')}Z" fill="#a46bff" fill-opacity="0.08" stroke="#a46bff" stroke-width="0.12" stroke-dasharray="0.5 0.3" pointer-events="none"><title>${esc(st.name)} · ${st.material} ${st.thickness} mm · ${st.side}</title></path>`);
    Pcb.keepouts().forEach((k, i) => {
      const d = `M${k.pts.map(q => q.join(' ')).join('L')}Z`, on = ui.item && ui.item.k === 'ko' && ui.item.i === i;
      out.push(`<path d="${d}" fill="url(#kohatch)" stroke="none" pointer-events="none" opacity="0.5"/>`);
      out.push(`<path ${k.auto ? '' : `data-k="ko" data-i="${i}" `}class="keepout${on ? ' on' : ''}" d="${d}" fill="none" stroke="#ff5a5a" stroke-width="${on ? 0.2 : 0.12}" stroke-dasharray="0.6 0.35" pointer-events="${k.auto ? 'none' : 'stroke'}"><title>${k.auto ? 'Automatic keep-out (rule epKeepout) ' : 'Keep-out '}"${esc(k.name)}" · ${k.layer === 'both' ? 'top + bottom' : k.layer === 'B' ? 'bottom' : 'top'} · no ${['tracks', 'vias', 'pours', 'parts'].filter(f => k[f]).join(', ')}</title></path>`);
    });
    out.push(`<g id="prats">${ratsHtml()}</g>`);
    if (vis('DRC') && ui.drc) for (const v of ui.drc.violations) if (v.x != null) out.push(`<g class="drcmark" transform="translate(${v.x} ${v.y})" stroke="${v.severity === 'error' ? col('DRC') : '#f0b429'}"><circle r="0.9" fill="none" stroke-width="0.12"/><path d="M-0.45 -0.45L0.45 0.45M0.45 -0.45L-0.45 0.45" stroke-width="0.14"/><title>${esc(v.msg)}</title></g>`);
    // selection outlines
    for (const r of new Set([...ui.multi, ...(ui.sel ? [ui.sel] : [])])) { const c = Model.comp(r); if (c && c.pcb) { const b = Pcb.fpBox(c, 0.2); out.push(`<rect data-o="${esc(c.ref)}" class="selbox" x="${b[0]}" y="${b[1]}" width="${b[2] - b[0]}" height="${b[3] - b[1]}"/>`); } }
    if (ui.item && ui.item.k === 'h') { const h = (S.pcb.holes || [])[ui.item.i]; if (h) out.push(`<circle class="selbox" cx="${h.x}" cy="${h.y}" r="${h.d / 2 + 0.4}"/>`); }
    if (ui.item && ['v', 't', 'T'].includes(ui.item.k)) {
      if (ui.item.k === 'v') { const v = S.pcb.vias[ui.item.i]; if (v) out.push(`<circle class="selbox" cx="${v.x}" cy="${v.y}" r="${v.d / 2 + 0.15}"/>`); }
      else { const t = S.pcb.traces[ui.item.i]; if (t) { const pts = ui.item.k === 'T' ? t.pts : [t.pts[ui.item.s - 1], t.pts[ui.item.s]]; out.push(`<polyline class="selline" points="${pts.map(p => p.join(',')).join(' ')}" stroke-width="${t.w + 0.2}"/>`); const a = pts[0], b = pts[pts.length - 1], fs = Math.min(1.2, Math.max(0.5, 14 / (vp.s || 10))); if (t.net) out.push(`<text class="netlabel-pcb" x="${(a[0] + b[0]) / 2}" y="${(a[1] + b[1]) / 2 - t.w / 2 - fs * 0.4}" text-anchor="middle" style="font-size:${fs}px">${esc(t.net)} · ${t.w} mm</text>`); } }
    }
    if (hl) out.push(netHighlight(hl));
    out.push(...lblHits);   // text grab areas on top of everything (DRC marks, selection outlines)
    out.push('<g id="pcbLive"></g>');
    world.innerHTML = out.join('');
    renderLiveLayer();
  }
  const ratsHtml = () => vis('RA') ? Pcb.ratsnest().map(r => `<line x1="${r.a.x}" y1="${r.a.y}" x2="${r.b.x}" y2="${r.b.y}" stroke="${col('RA')}" stroke-width="0.08" pointer-events="none"><title>${esc(r.net)}</title></line>`).join('') : '';
  // part drag: move the dragged parts' elements, stretch the tracks attached to their pads and redraw the
  // ratsnest — the full redraw (about 250 kB of SVG on a busy board) waits for the mouse button to come up
  function dragFast(d, dx, dy) {
    if (!d.els) {
      const own = new Set(d.orig.map(o => o[0].ref)), tr = new Set(d.ends.map(t => String(t.i)));
      d.els = [...world.querySelectorAll('[data-o]')].filter(e => own.has(e.dataset.o));
      d.lines = {}; for (const e of world.querySelectorAll('line[data-k="t"]')) if (tr.has(e.dataset.i)) (d.lines[e.dataset.i] = d.lines[e.dataset.i] || []).push(e);
      // guide lines while dragging (the exact ratsnest needs the full connectivity, ≈ 25 ms on a busy board): each moved
      // pad to the nearest pad of its net on the other parts — not for pads a following track keeps connected, or poured nets
      const S = Model.S, poured = new Set((S.pcb.pours || []).map(p => p.net)), kept = new Set();
      for (const t of d.ends) { const tr0 = S.pcb.traces[t.i]; for (const p of cache.pads) if (own.has(p.ref) && p.net === tr0.net) for (const k of t.ks) if (G.padDist(p, t.orig[k][0], t.orig[k][1]) <= 1e-3) kept.add(p.uid); }
      d.fly = cache.pads.filter(p => own.has(p.ref) && p.net && !poured.has(p.net) && !kept.has(p.uid))
        .map(p => ({ p, to: cache.pads.filter(q => q.net === p.net && !own.has(q.ref)) })).filter(f => f.to.length);
    }
    for (const e of d.els) e.setAttribute('transform', `translate(${dx} ${dy})`);
    for (const t of d.ends) for (const e of d.lines[t.i] || []) { const s = +e.dataset.s, p = Model.S.pcb.traces[t.i].pts; e.setAttribute('x1', p[s - 1][0]); e.setAttribute('y1', p[s - 1][1]); e.setAttribute('x2', p[s][0]); e.setAttribute('y2', p[s][1]); }
    const r = world.querySelector('#prats');
    if (r && vis('RA')) r.innerHTML = d.fly.map(({ p, to }) => {
      const x = p.x + dx, y = p.y + dy, q = to.reduce((a, b) => Math.hypot(b.x - x, b.y - y) < Math.hypot(a.x - x, a.y - y) ? b : a);
      return `<line x1="${x}" y1="${y}" x2="${q.x}" y2="${q.y}" stroke="${col('RA')}" stroke-width="0.08" pointer-events="none"/>`;
    }).join('');
  }
  // tracks that end on a pad of the dragged parts: those ends follow the parts (a track between two dragged parts moves whole)
  function attachedEnds(refs) {
    const own = new Set(refs), pads = cache.pads.filter(p => own.has(p.ref)), out = [];
    const on = (q, t) => pads.some(p => (!t.net || !p.net || p.net === t.net) && (p.drill || (p.layer || 'F') === t.layer) && G.padDist(p, q[0], q[1]) <= 1e-3);
    Model.S.pcb.traces.forEach((t, i) => {
      const a = on(t.pts[0], t), b = on(t.pts[t.pts.length - 1], t);
      if (a || b) out.push({ i, orig: t.pts.map(q => q.slice()), ks: a && b ? t.pts.map((_, k) => k) : [a ? 0 : t.pts.length - 1] });
    });
    return out;
  }
  // routing preview / cursor / measure are redrawn on mouse move without touching the board
  function renderLive() { if (world && world.querySelector('#pcbLive')) renderLiveLayer(); }
  function renderLiveLayer() {
    const live = world && world.querySelector('#pcbLive'); if (!live) return;
    const out = [], R = ui.route, c = ui.cursor;
    if (R) {
      for (const d of R.done) out.push(`<polyline points="${d.pts.map(p => p.join(',')).join(' ')}" stroke="${col(d.layer)}" stroke-width="${d.w}" class="rprev"/>`);
      for (const v of R.vias) out.push(`<circle cx="${v.x}" cy="${v.y}" r="${Pcb.rules().viaDiameter / 2}" fill="${col('MU')}"/><circle cx="${v.x}" cy="${v.y}" r="${Pcb.rules().viaDrill / 2}" fill="#111"/>`);
      const last = R.pts[R.pts.length - 1], prev = c ? bend(last, [c.x, c.y]) : [];
      const pts = R.pts.concat(prev), bad = checkClear([last].concat(prev), R.w, R);
      out.push(`<polyline points="${pts.map(p => p.join(',')).join(' ')}" stroke="${col(R.layer)}" stroke-width="${R.w}" class="rprev${bad ? ' bad' : ''}"/>`);
      if (bad) out.push(`<polyline points="${[last].concat(prev).map(p => p.join(',')).join(' ')}" stroke="#ffffff" stroke-width="${R.w}" stroke-dasharray="0.2 0.2" fill="none" opacity="0.8"/>`);
      R.bad = bad;
    }
    if (c && ui.tool !== 'select') {
      const s = 0.8;
      out.push(`<path d="M${c.x - s} ${c.y}H${c.x + s}M${c.x} ${c.y - s}V${c.y + s}" stroke="${c.obj ? '#00ff9c' : '#ffffff'}" stroke-width="0.05"/>`);
      if (c.obj) out.push(`<circle cx="${c.x}" cy="${c.y}" r="0.3" fill="none" stroke="#00ff9c" stroke-width="0.06"/>`);
      if (ui.tool === 'via') out.push(`<circle cx="${c.x}" cy="${c.y}" r="${Pcb.rules().viaDiameter / 2}" fill="${col('MU')}" opacity="0.6"/>`);
    }
    if (ui.arc) {
      const A = ui.arc, cur = c ? [c.x, c.y] : A.a;
      const pts = A.b ? arcPoints(A.a, A.b, cur) : [A.a, cur];
      out.push(`<polyline points="${pts.map(p => p.join(',')).join(' ')}" stroke="${col(A.layer)}" stroke-width="${curWidth(A.net)}" class="rprev"/>`);
    }
    if (ui.poly) {
      const P = ui.poly.pts.concat(c ? [[c.x, c.y]] : []), colr = ui.poly.kind === 'outline' ? col('OL') : ui.poly.kind === 'keepout' ? '#ff5a5a' : col(ui.active);
      out.push(`<polygon points="${P.map(p => p.join(',')).join(' ')}" fill="${colr}" fill-opacity="0.18" stroke="${colr}" stroke-width="0.1" stroke-dasharray="0.4 0.25"/>`);
      if (P.length) out.push(`<circle cx="${P[0][0]}" cy="${P[0][1]}" r="0.35" fill="none" stroke="#fff" stroke-width="0.08"/>`);
    }
    if (ui.measure) {
      const { a, b } = ui.measure, d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      out.push(`<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="#00e5ff" stroke-width="0.06"/><circle cx="${a[0]}" cy="${a[1]}" r="0.15" fill="#00e5ff"/><circle cx="${b[0]}" cy="${b[1]}" r="0.15" fill="#00e5ff"/>`);
      out.push(`<text x="${(a[0] + b[0]) / 2 + 0.3}" y="${(a[1] + b[1]) / 2 - 0.3}" fill="#00e5ff" style="font-size:0.9px;font-weight:700">${d.toFixed(3)} mm · ${(d / 0.0254).toFixed(1)} mil (Δx ${(b[0] - a[0]).toFixed(2)}, Δy ${(b[1] - a[1]).toFixed(2)})</text>`);
    }
    live.innerHTML = out.join('');
    coord();
  }
  function coord() {
    const el = $('#pcbCoord'); if (!el) return;
    const c = ui.cursor, R = ui.route;
    let s = c ? `X ${c.x.toFixed(3)}  Y ${c.y.toFixed(3)} mm` : '';
    s += ` · <b style="color:${col(ui.active)}">${LNAME[ui.active]}</b> · ${(TOOLS.find(t => t.id === ui.tool) || {}).name}`;
    if (ui.tool === 'track' || ui.tool === 'arc') s += ` · width ${R ? R.w : curWidth(null)} mm · ${ui.angle === 'any' ? 'any angle' : ui.angle + '°'}`;
    if (R) s += ` · net <b>${esc(R.net || '(none)')}</b>`;
    if (R && R.bad) s += ` · <span class="bad">⚠ ${R.bad.d <= 0 ? 'short' : 'clearance ' + R.bad.d.toFixed(3) + ' mm'} to ${esc(R.bad.what)} (rule ${R.bad.need || Pcb.rules().clearance})</span>`;
    if (ui.tool === 'track') s += ` <span class="muted">· right-click (or V) via + other layer · Space angle · / bend · Backspace undo · Esc or double-click finish · ${ui.free ? '<b>no rules</b> (DRC checks later)' : 'rule breaks are not placed'}</span>`;
    if (ui.tool === 'arc') s += ` <span class="muted">· click start, click end, then click to set the curve · Esc cancels</span>`;
    if (ui.tool === 'pour' || ui.tool === 'outline' || ui.tool === 'keepout') s += ` <span class="muted">· click corners, click the first corner (or Enter) to close · Backspace removes a corner · Esc cancels</span>`;
    el.innerHTML = s;
  }

  // ---------- properties (track / via) ----------
  function props(el) {
    const it = ui.item; if (!it) return false;
    const S = Model.S, nets = Object.keys(S.nets).sort();
    const netSel = cur => `<select id="ppNet"><option value="">(no net)</option>${nets.map(n => `<option ${n === cur ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
    if (it.k === 'txt') {
      const t = (S.pcb.texts || [])[it.i]; if (!t) return false;
      el.innerHTML = `<div class="ph">Silkscreen text</div>
        <label>Text<input id="ptT" value="${esc(t.text)}"></label>
        <label>Size (mm)<input id="ptH" type="number" step="0.1" min="0.6" value="${t.h}"></label>
        <label>Rotation (°, counter-clockwise)<input id="ptR" type="number" step="15" value="${t.rot || 0}"></label>
        <label>Side<select id="ptS"><option value="F" ${t.side !== 'B' ? 'selected' : ''}>Top</option><option value="B" ${t.side === 'B' ? 'selected' : ''}>Bottom (mirrored)</option></select></label>
        <label>X (mm)<input id="ptX" type="number" step="${ui.grid}" value="${t.x}"></label><label>Y (mm)<input id="ptY" type="number" step="${ui.grid}" value="${t.y}"></label>
        <div class="muted small">Drag the text to move it, drag its corner square to resize · R rotates 90° · + / − change the size. 1 mm is the smallest size JLCPCB prints clearly.</div>
        <div class="row"><button id="ppDel" class="danger">Delete text (Del)</button></div>`;
      const upd = o => Model.mutate(() => Pcb.updateText(it.i, o));
      $('#ptT').onchange = e => upd({ text: e.target.value }); $('#ptH').onchange = e => upd({ size: +e.target.value }); $('#ptR').onchange = e => upd({ rotation: +e.target.value || 0 }); $('#ptS').onchange = e => upd({ side: e.target.value });
      $('#ptX').onchange = e => upd({ x: +e.target.value }); $('#ptY').onchange = e => upd({ y: +e.target.value });
      $('#ppDel').onclick = deleteItem;
      return true;
    }
    if (it.k === 'blbl') {
      const L = S.pcb.boardLabel || {};
      el.innerHTML = `<div class="ph">Board name on the silkscreen</div>
        <label>Text<input id="pbT" value="${esc(L.text != null ? L.text : '')}" placeholder="${esc(S.name || '')}"></label>
        <label>Size (mm)<input id="pbH" type="number" step="0.1" min="0.6" value="${L.h || ''}" placeholder="1.2"></label>
        <label>Rotation (°)<input id="pbR" type="number" step="15" value="${L.rot || 0}"></label>
        <label class="chk"><input type="checkbox" id="pbHide" ${L.hide ? 'checked' : ''}> Hide</label>
        <div class="row"><button id="pbAuto">Automatic position</button></div>
        <div class="muted small">Empty text = the project name. Drag it on the board to move it.</div>`;
      const upd = o => Model.mutate(() => Pcb.setSilkLabel('board', o));
      $('#pbT').onchange = e => upd({ text: e.target.value }); $('#pbH').onchange = e => upd({ size: +e.target.value || 1.2 }); $('#pbHide').onchange = e => upd({ hidden: e.target.checked });
      $('#pbAuto').onclick = () => upd({ auto: true }); $('#pbR').onchange = e => upd({ rotation: +e.target.value || 0 });
      return true;
    }
    if (it.k === 'h') {
      const h = S.pcb.holes && S.pcb.holes[it.i]; if (!h) return false;
      el.innerHTML = `<div class="ph">Mounting hole</div>
        <label>Diameter (mm)<input id="phD" type="number" step="0.1" value="${h.d}"></label>
        <label>X (mm)<input id="phX" type="number" step="${ui.grid}" value="${h.x}"></label><label>Y (mm)<input id="phY" type="number" step="${ui.grid}" value="${h.y}"></label>
        <div class="muted small">Non-plated hole (NPTH drill file). Copper keeps the clearance rule from it; the enclosure puts a screw standoff here.</div>
        <div class="row"><button id="ppDel" class="danger">Delete hole (Del)</button></div>`;
      const upd = f => Model.mutate(() => { const q = Model.S.pcb.holes[it.i]; f(q); q.auto = false; });
      $('#phD').onchange = e => upd(q => q.d = Math.max(0.5, +e.target.value)); $('#phX').onchange = e => upd(q => q.x = +e.target.value); $('#phY').onchange = e => upd(q => q.y = +e.target.value);
      $('#ppDel').onclick = deleteItem;
      return true;
    }
    if (it.k === 'ko') {
      const k = (S.pcb.keepouts || [])[it.i]; if (!k) return false;
      const chk = (id, on, t) => `<label class="chk"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}> ${t}</label>`;
      el.innerHTML = `<div class="ph">Keep-out area</div><label>Name<input id="pkN" value="${esc(k.name)}"></label>
        <label>Layers<select id="pkL"><option value="both" ${k.layer === 'both' ? 'selected' : ''}>Top + bottom</option><option value="F" ${k.layer === 'F' ? 'selected' : ''}>Top only</option><option value="B" ${k.layer === 'B' ? 'selected' : ''}>Bottom only</option></select></label>
        ${chk('pkT', k.tracks, 'No tracks')}${chk('pkV', k.vias, 'No vias')}${chk('pkP', k.pours, 'No copper pour')}${chk('pkC', k.parts, 'No parts')}
        <div class="muted small">The autorouter and copper pours keep out; DRC reports anything inside. Press Route after changing it.</div>
        <div class="row"><button id="ppDel" class="danger">Delete keep-out (Del)</button></div>`;
      const upd = f => Model.mutate(() => { const K = Model.S.pcb.keepouts.slice(); K[it.i] = Object.assign({}, K[it.i]); f(K[it.i]); Model.S.pcb.keepouts = K; });
      $('#pkN').onchange = e => upd(q => q.name = e.target.value.slice(0, 60) || q.name);
      $('#pkL').onchange = e => upd(q => q.layer = e.target.value);
      for (const [id, f] of [['pkT', 'tracks'], ['pkV', 'vias'], ['pkP', 'pours'], ['pkC', 'parts']]) $('#' + id).onchange = e => upd(q => q[f] = e.target.checked);
      $('#ppDel').onclick = deleteItem;
      return true;
    }
    if (it.k === 'pour') {
      const pr = S.pcb.pours && S.pcb.pours[it.i]; if (!pr) return false;
      el.innerHTML = `<div class="ph">Copper area</div><label>Net${netSel(pr.net)}</label>
        <label>Layer<select id="ppL"><option value="F" ${pr.layer === 'F' ? 'selected' : ''}>TopLayer</option><option value="B" ${pr.layer === 'B' ? 'selected' : ''}>BottomLayer</option></select></label>
        <label>Clearance (mm, empty = rule ${Pcb.rules().clearance})<input id="ppC" type="number" step="0.05" value="${pr.clearance || ''}"></label>
        <div class="muted small">${pr.whole ? 'Covers the whole board (follows the outline)' : pr.pts.length + '-corner area'} · other nets keep their clearance; same-net pads, tracks and vias connect to it.</div>
        <div class="row"><button id="ppDel" class="danger">Delete copper area (Del)</button></div>`;
      const upd = f => Model.mutate(() => f(Model.S.pcb.pours[it.i]));
      $('#ppNet').onchange = e => { if (e.target.value) upd(p => p.net = e.target.value); };
      $('#ppL').onchange = e => upd(p => p.layer = e.target.value);
      $('#ppC').onchange = e => upd(p => { if (+e.target.value > 0) p.clearance = +e.target.value; else delete p.clearance; });
      $('#ppDel').onclick = deleteItem;
      return true;
    }
    if (it.k === 'v') {
      const v = S.pcb.vias[it.i]; if (!v) return false;
      el.innerHTML = `<div class="ph">Via</div><label>Net${netSel(v.net)}</label>
        <label>Diameter (mm)<input id="ppD" type="number" step="0.05" value="${v.d}"></label><label>Drill (mm)<input id="ppDr" type="number" step="0.05" value="${v.drill}"></label>
        <label>X (mm)<input id="ppX" type="number" step="${ui.grid}" value="${v.x}"></label><label>Y (mm)<input id="ppY" type="number" step="${ui.grid}" value="${v.y}"></label>
        <div class="row"><button id="ppDel" class="danger">Delete (Del)</button></div>`;
      const upd = f => Model.mutate(() => f(Model.S.pcb.vias[it.i]));
      $('#ppNet').onchange = e => upd(v => v.net = e.target.value || null);
      $('#ppD').onchange = e => upd(v => v.d = +e.target.value); $('#ppDr').onchange = e => upd(v => v.drill = +e.target.value);
      $('#ppX').onchange = e => upd(v => v.x = +e.target.value); $('#ppY').onchange = e => upd(v => v.y = +e.target.value);
    } else {
      const t = S.pcb.traces[it.i]; if (!t) return false;
      let len = 0; for (let i = 1; i < t.pts.length; i++) len += Math.hypot(t.pts[i][0] - t.pts[i - 1][0], t.pts[i][1] - t.pts[i - 1][1]);
      const R = Pcb.rules(), netT = t.net ? S.pcb.traces.filter(q => q.net === t.net) : [t], netV = t.net ? S.pcb.vias.filter(v => v.net === t.net).length : 0;
      const pins = t.net ? (S.nets[t.net] || []) : [], widths = [...new Set(netT.map(q => q.w))].sort((a, b) => a - b);
      el.innerHTML = `<div class="ph">Net <span class="pnet">${esc(t.net || '(no net)')}</span></div>
        <div class="muted small">${netT.length} track${netT.length > 1 ? 's' : ''}${netV ? ` · ${netV} via${netV > 1 ? 's' : ''}` : ''} · ${pins.length} pin${pins.length === 1 ? '' : 's'}${widths.length > 1 ? ` · widths ${widths.join(' / ')} mm` : ''}</div>
        ${(() => { const refs = [...new Set(pins.map(k => k.slice(0, k.lastIndexOf('.'))))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })); return refs.length ? `<div class="ph small">Connected parts (${refs.length})</div><div class="pinlist">${refs.map(r => `<span data-goref="${esc(r)}" title="Select ${esc(r)}">${esc(r)}</span>`).join('')}</div><div class="ph small">Pins</div>` : ''; })()}
        ${pins.length ? `<div class="pinlist">${pins.map(k => `<span>${esc(k)}</span>`).join('')}</div>` : ''}
        <div class="ph small">This track ${it.k === 'T' ? '' : `<span class="muted">· segment ${it.s}</span>`}</div>
        <label>Net${netSel(t.net)}</label>
        <label>Layer<select id="ppL"><option value="F" ${t.layer === 'F' ? 'selected' : ''}>TopLayer</option><option value="B" ${t.layer === 'B' ? 'selected' : ''}>BottomLayer</option></select></label>
        <label>Width (mm) <span class="muted">· rule ${R.traceWidth}, fab min ${R.minTraceWidth}</span><input id="ppW" type="number" step="0.05" min="${R.minTraceWidth}" value="${t.w}"></label>
        <div class="row"><button id="ppWNet" title="Set every track of ${esc(t.net || 'this net')} to this width">Width → whole net</button><button id="ppWAll" title="Set every track on the board to this width">Width → all tracks</button></div>
        <div class="row"><button id="ppWRule" title="Tracks wider than the rule (${R.traceWidth} mm, or the per-net width from Rules) go back to it; necked-down tracks stay">Reset wide tracks to rule width</button></div>
        <div class="muted small">Length ${len.toFixed(2)} mm · ${t.pts.length - 1} segments${t.manual ? ' · hand-routed' : ' · autorouted'} · double-click a track to select all of it</div>
        <div class="row"><button id="ppDel" class="danger">Delete ${it.k === 'T' ? 'track' : 'segment'} (Del)</button></div>`;
      const upd = f => Model.mutate(() => f(Model.S.pcb.traces[it.i]));
      const wOk = () => { const w = +$('#ppW').value; if (!(w >= 0.05)) { App.toast('Enter a width in mm'); return 0; } if (w < R.minTraceWidth) App.toast(`${w} mm is below the fab minimum ${R.minTraceWidth} mm`); return +w.toFixed(3); };
      const setW = (pick, what) => { const w = wOk(); if (!w) return; let n = 0; Model.mutate(() => { for (const q of Model.S.pcb.traces) if (pick(q)) { q.w = w; n++; } }); const cl = Pcb.drc().violations.filter(v => /^Clearance|short/i.test(v.msg)).length; App.toast(`${n} track${n === 1 ? '' : 's'} (${what}) set to ${w} mm${cl ? ` · ⚠ ${cl} clearance problem${cl > 1 ? 's' : ''} — a track no longer fits somewhere (Ctrl+Z to undo, or Route again)` : ' · clearances OK'}`, 8000); };
      $('#ppNet').onchange = e => upd(t => t.net = e.target.value || null);
      $('#ppL').onchange = e => upd(t => t.layer = e.target.value);
      el.querySelectorAll('[data-goref]').forEach(b => b.onclick = () => { const c = Model.comp(b.dataset.goref); setSelection([b.dataset.goref]); if (c && c.pcb && vp.reveal) vp.reveal(Pcb.fpBox(c), 4); });
      $('#ppW').onchange = e => { const w = wOk(); if (w) upd(t => t.w = w); };
      $('#ppWNet').onclick = () => setW(q => t.net ? q.net === t.net : q === t, t.net || 'this track');
      $('#ppWAll').onclick = () => setW(() => true, 'all');
      $('#ppWRule').onclick = () => {
        // wider tracks go back to the rule width; tracks the router necked down between tight pads stay as they are
        let n = 0, neck = 0; Model.mutate(() => { for (const q of Model.S.pcb.traces) { const w = Pcb.netWidth(q.net); if (q.w > w + 1e-9) { q.w = w; n++; } else if (q.w < w - 1e-9) neck++; } });
        App.toast(`${n ? `${n} track${n === 1 ? '' : 's'} set to the rule width` : 'No track is wider than the rule'}${neck ? ` · ${neck} stay narrower: the router necked them down where the full width does not fit (e.g. between fine-pitch pins)` : ''}`, 8000);
      };
    }
    $('#ppDel').onclick = deleteItem;
    return true;
  }

  const fit = () => { const S = Model.S; vp && vp.fit(S.board.w ? [0, 0, S.board.w, S.board.h] : [-30, -20, 30, 20], 4); };
  function exportSVG() {
    const S = Model.S;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 ${S.board.w + 4} ${S.board.h + 4}" width="${(S.board.w + 4) * 10}" height="${(S.board.h + 4) * 10}" style="background:#000"><style>.fphit{fill:none}.trk{stroke-linecap:round}.selbox,.selline,.lblhit,.lblsize,.nethl{display:none}</style><rect x="-2" y="-2" width="${S.board.w + 4}" height="${S.board.h + 4}" fill="#000"/>${world.innerHTML.replace(/<g id="pcbLive">.*?<\/g>$/, '')}</svg>`;
  }
  // keep the item selection valid after undo/redo or external edits
  function validate() {
    const S = Model.S;
    const it = ui.item, gone = it && (it.k === 'v' ? !S.pcb.vias[it.i] : it.k === 'pour' ? !(S.pcb.pours || [])[it.i] : it.k === 'ko' ? !(S.pcb.keepouts || [])[it.i] : it.k === 'h' ? !(S.pcb.holes || [])[it.i]
      : it.k === 'txt' ? !(S.pcb.texts || [])[it.i] : it.k === 'blbl' ? false : !S.pcb.traces[it.i]);   // t / T: tracks
    if (gone) ui.item = null;
    if (ui.sel && !Model.comp(ui.sel)) ui.sel = null;
    for (const r of [...ui.multi]) if (!Model.comp(r)) ui.multi.delete(r);
  }
  return { init, render: () => { validate(); render(); coord(); }, fit, key, ui, selected, setSelection, selectAll, rotate, del, flip, exportSVG, setVisible, bindBar, props, setTool, LAYERS, drawOutline: r => { ui.outlineR = +r || 0; setTool('outline'); App.toast('Click the outline corners; click the first corner to close'); }, get vp() { return vp; } };
})();
// Expose the editor through the Pcb namespace used by the rest of the app.
Object.assign(Pcb, { init: PcbView.init, render: PcbView.render, fit: PcbView.fit, key: PcbView.key, exportSVG: PcbView.exportSVG, ui: PcbView.ui });
Object.defineProperty(Pcb, 'vp', { get: () => PcbView.vp });
