'use strict';
// Enclosure tab: parameters, 3D preview (three.js from cdnjs), STL / OpenSCAD export.
const EncView = (() => {
  const $ = s => document.querySelector(s);
  const ui = { explode: false, lid: true, pcb: true, xray: false, section: null, built: null, err: null, showDims: false, measure: false, rulers: [], dims: null };
  const WORKER = 'js/shape-worker.js?v=202610280100';
  let three = null, scene, camera, renderer, root, wrap, cam = { th: -0.9, ph: 1.0, r: 160, tx: 0, ty: 0, tz: 10 }, dirty = true, timer = null, active = false;

  function loadThree() {
    if (window.THREE) return Promise.resolve(window.THREE);
    if (three) return three;
    three = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
      s.onload = () => res(window.THREE); s.onerror = () => rej(new Error('Could not load three.js (needs internet) — STL export still works'));
      document.head.appendChild(s);
    });
    return three;
  }
  function init() {
    wrap = $('#encView');
    wrap.innerHTML = `<div id="encMsg" class="encmsg"></div><div id="encInfo" class="encinfo"></div>
      <div id="encCodePanel" class="enc-code hidden">
        <div class="ecp-head"><b>3D script</b>
          <select id="encTpl" title="Start from a template (all are sized from your board)"><option value="">Templates…</option>${['Wrist', 'Chest', 'Body', 'Box'].map(cat => `<optgroup label="${{ Wrist: 'Wrist wearables', Chest: 'Chest / ECG', Body: 'Other body-worn', Box: 'Boxes' }[cat]}">${Shape3D.TEMPLATES.filter(t => t.cat === cat).map(t => `<option value="${t.id}" title="${esc(t.desc)}">${esc(t.name)}</option>`).join('')}</optgroup>`).join('')}</select>
          <button id="encHelp" title="Script API reference">?</button>
          <button id="encRun" class="primary" title="Build the model (Ctrl+Enter)">▶ Run</button>
          <button id="encCodeClose" title="Hide the editor">✕</button></div>
        <textarea id="encCode" spellcheck="false" autocomplete="off" autocapitalize="off"></textarea>
        <div id="encOut" class="ecp-out"></div>
      </div>`;
    $('#encMode').onclick = e => { const b = e.target.closest('button'); if (b) setMode(b.dataset.m); };
    $('#encCodeBtn').onclick = () => toggleCode();
    $('#encCodeClose').onclick = () => toggleCode(false);
    $('#encRun').onclick = runEditor;
    $('#encCode').addEventListener('input', () => { codeDirty = true; });
    $('#encCode').addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runEditor(); }
      else if (e.key === 'Tab') { e.preventDefault(); const t = e.target, s = t.selectionStart; t.setRangeText('  ', s, t.selectionEnd, 'end'); codeDirty = true; }
    });
    $('#encTpl').onchange = e => { const k = e.target.value; e.target.value = ''; if (!k) return; if (codeDirty && !confirm('Replace the script in the editor with the template?')) return; $('#encCode').value = (Shape3D.TEMPLATES.find(t => t.id === k) || {}).code || Shape3D.EXAMPLES[k]; codeDirty = true; runEditor(); };
    $('#encHelp').onclick = () => { $('#encOut').innerHTML = `<pre class="ecp-help">${esc(Shape3D.HELP)}</pre>`; };
    $('#encRegen').onclick = () => { dirty = true; rebuild(true); };
    $('#encExplode').onclick = () => { ui.explode = !ui.explode; $('#encExplode').classList.toggle('on', ui.explode); place(); };
    $('#encLid').onclick = () => { ui.lid = !ui.lid; $('#encLid').classList.toggle('on', ui.lid); place(); };
    $('#encPcb').onclick = () => { ui.pcb = !ui.pcb; $('#encPcb').classList.toggle('on', ui.pcb); place(); };
    $('#encXray').onclick = () => { ui.xray = !ui.xray; $('#encXray').classList.toggle('on', ui.xray); place(); };
    $('#encSection').onclick = () => { ui.section = ui.section ? null : 'x'; $('#encSection').classList.toggle('on', !!ui.section); place(); };
    $('#encRender').onclick = renderDialog;
    $('#encDims').onclick = () => { ui.showDims = !ui.showDims; $('#encDims').classList.toggle('on', ui.showDims); drawOverlay(); draw(); };
    $('#encMeasure').onclick = () => setMeasure(!ui.measure);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && active && ui.measure) { if (ui.pendingA || ui.rulers.length) { ui.pendingA = null; ui.rulers = []; drawOverlay(); draw(); dimText(); } else setMeasure(false); } });
    $('#encStl').onclick = () => exportAll('stl'); $('#encScad').onclick = () => exportAll('scad'); $('#encZip').onclick = () => exportAll('zip');
    $('#encOrder').onclick = () => {
      // open the quote page inside the click (popup blockers), then build + download the STLs
      window.open('https://jlc3dp.com/3d-printing-quote', '_blank', 'noopener');
      (async () => {
        if (Enclosure.mode() === 'custom' && !(ui.custom && ui.custom.r)) { App.toast('Building the 3D model…', 20000); try { await runScript(Enclosure.script()); } catch (e) { } }
        return exportAll('stl');
      })().then(ok => ok && App.toast('STL files saved to Downloads — on JLC3DP click “Add 3D files”, upload them and pick a material (SLA resin for fine detail, PA12 nylon or TPU for wearables)', 20000));
    };
    ['encLid', 'encPcb'].forEach(id => $('#' + id).classList.add('on'));
    Model.subscribe(kind => { if (kind === 'move') return; dirty = true; if (active) { clearTimeout(timer); timer = setTimeout(() => rebuild(false), 500); } });
  }
  async function show() {
    active = true;
    try { await loadThree(); } catch (e) { msg(e.message); }
    if (window.THREE && !renderer) setupScene();
    if (dirty) rebuild(false); else { resize(); draw(); }
  }
  function hide() { active = false; }
  const msg = t => { const m = $('#encMsg'); if (m) { m.textContent = t || ''; m.style.display = t ? 'block' : 'none'; } };

  // ---------- three.js scene ----------
  function setupScene() {
    const T = window.THREE;
    renderer = new T.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.localClippingEnabled = true;
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    const bg = () => renderer.setClearColor(getComputedStyle(document.documentElement).getPropertyValue('--view3d').trim() || '#12161c');
    bg(); window.addEventListener('themechange', () => { bg(); draw(); });
    wrap.prepend(renderer.domElement);
    scene = new T.Scene();
    camera = new T.PerspectiveCamera(35, 1, 0.5, 5000); camera.up.set(0, 0, 1);
    scene.add(new T.HemisphereLight(0xffffff, 0x334455, 0.75));
    const d1 = new T.DirectionalLight(0xffffff, 0.75); d1.position.set(80, -120, 200); scene.add(d1);
    const d2 = new T.DirectionalLight(0xffffff, 0.35); d2.position.set(-150, 100, 80); scene.add(d2);
    root = new T.Group(); scene.add(root);
    // orbit / pan / zoom
    const el = renderer.domElement; let drag = null;
    el.addEventListener('contextmenu', e => e.preventDefault());
    el.addEventListener('mousedown', e => { drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, pan: e.button !== 0 || e.shiftKey }; });
    window.addEventListener('mouseup', e => { if (drag && ui.measure && e.button === 0 && e.target === el && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 4) pick(e); drag = null; });
    window.addEventListener('mousemove', e => {
      if (!drag || !active) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
      if (drag.pan) { const k = cam.r / 600, s = Math.sin(cam.th), c = Math.cos(cam.th); cam.tx -= (dx * c + dy * s * Math.cos(cam.ph)) * k; cam.ty -= (dx * s - dy * c * Math.cos(cam.ph)) * k; cam.tz += dy * Math.sin(cam.ph) * k; }
      else { cam.th -= dx * 0.008; cam.ph = Math.max(0.05, Math.min(Math.PI - 0.05, cam.ph - dy * 0.008)); }
      draw();
    });
    el.addEventListener('wheel', e => { e.preventDefault(); cam.r = Math.max(20, Math.min(2000, cam.r * Math.exp(e.deltaY * 0.001))); draw(); }, { passive: false });
    new ResizeObserver(() => { if (active) { resize(); draw(); } }).observe(wrap);
    resize();
  }
  function resize() {
    if (!renderer) return;
    const r = wrap.getBoundingClientRect(); if (!r.width) return;
    let w = r.width, h = r.height;
    const p = $('#encCodePanel');   // keep the 3D view beside / above the script editor
    if (p && !p.classList.contains('hidden')) { const q = p.getBoundingClientRect(); if (q.top > r.top + 4) h = Math.max(120, q.top - r.top); else w = Math.max(160, r.width - q.width); }
    renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  function draw() {
    if (!renderer) return;
    camera.position.set(cam.tx + cam.r * Math.sin(cam.ph) * Math.cos(cam.th), cam.ty + cam.r * Math.sin(cam.ph) * Math.sin(cam.th), cam.tz + cam.r * Math.cos(cam.ph));
    camera.lookAt(cam.tx, cam.ty, cam.tz); renderer.render(scene, camera);
  }
  const meshes = {};
  function meshFrom(polys, color, opts = {}) {
    const T = window.THREE, a = Enclosure.meshArrays(polys, opts.tf), g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(a.pos, 3)); g.setAttribute('normal', new T.BufferAttribute(a.nor, 3));
    const m = new T.MeshStandardMaterial({ color, roughness: 0.65, metalness: 0.05, transparent: true, opacity: opts.opacity || 1, side: T.DoubleSide });
    return withCap(new T.Mesh(g, m));
  }
  // section view: every material is clipped by one plane; the inside of a cut solid shows its back faces, drawn in a
  // flat red so the cut walls read as solid (the usual CAD look)
  const clip = { plane: null };
  function clipPlane() { if (!clip.plane) clip.plane = new window.THREE.Plane(new window.THREE.Vector3(0, -1, 0), 0); return clip.plane; }
  function withCap(mesh) {
    const T = window.THREE, cap = new T.Mesh(mesh.geometry, new T.MeshBasicMaterial({ color: 0xd9534f, side: T.BackSide }));
    cap.visible = false; cap.userData.cap = true; mesh.add(cap); return mesh;
  }
  function applySection() {
    if (!root) return;
    const on = !!ui.section, pl = clipPlane();
    if (on) {
      // cut through the middle of what is shown; keep the half away from the camera
      const box = new window.THREE.Box3(); root.updateMatrixWorld(true); root.traverse(m => { if (m.isMesh && m.visible && !m.userData.cap) box.expandByObject(m); });
      const c = box.isEmpty() ? new window.THREE.Vector3() : box.getCenter(new window.THREE.Vector3());
      const ax = ui.section === 'y' ? 'x' : 'y', side = (ax === 'y' ? Math.sin(cam.th) : Math.cos(cam.th)) >= 0 ? -1 : 1;
      pl.normal.set(ax === 'x' ? side : 0, ax === 'y' ? side : 0, 0); pl.constant = -(ax === 'x' ? c.x : c.y) * side;
    }
    root.traverse(m => {
      if (!m.isMesh) return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      const capped = m.children.some(c => c.userData.cap);
      for (const mt of mats) { mt.clippingPlanes = on ? [pl] : null; if (capped) mt.side = on ? window.THREE.FrontSide : window.THREE.DoubleSide; mt.needsUpdate = true; }
      if (m.userData.cap) m.visible = on && m.parent.visible;
    });
  }
  function pcbGroup(L) {
    const T = window.THREE, g = new T.Group();
    const sh = new T.Shape(L.bpoly.map(q => new T.Vector2(q[0], q[1])));
    for (const h of L.holes) { const p = new T.Path(); p.absarc(h.x, h.y, h.d / 2, 0, Math.PI * 2, true); sh.holes.push(p); }
    const board = new T.Mesh(new T.ExtrudeGeometry(sh, { depth: L.P.pcbThickness, bevelEnabled: false }), new T.MeshStandardMaterial({ color: 0x1f7a3a, roughness: 0.8 }));
    board.position.z = L.pcbZ; g.add(board);
    const colors = { part: 0x2b2b2b, ic: 0x2b2b2b, connector: 0xc9c9c9, resistor: 0x2a6cc0, capacitor: 0xb08850, capacitor_polarized: 0x2d3fa0, led: 0x37d67a, switch: 0x555555, regulator: 0x333333, battery: 0x222222 };
    if (L.battery) g.add(batteryMesh(L.battery, [0, 0, 0]));
    for (const p of L.parts) {
      const w = Math.max(0.6, p.x1 - p.x0), d = Math.max(0.6, p.y1 - p.y0), h = Math.max(0.4, p.h);
      const col = p.edge && p.edge.plug ? 0xd8d8d8 : (colors[p.type] ?? 0x3a3a3a);
      const b = new T.Mesh(new T.BoxGeometry(w * 0.92, d * 0.92, h), new T.MeshStandardMaterial({ color: col, roughness: 0.5, metalness: p.edge && p.edge.plug ? 0.6 : 0.1 }));
      b.position.set((p.x0 + p.x1) / 2, (p.y0 + p.y1) / 2, p.bottom ? L.pcbZ - h / 2 : L.pcbZ + L.P.pcbThickness + h / 2);
      g.add(b);
    }
    return g;
  }
  // a loose battery: coin = steel disc, LiPo = silver pouch, cylinder = blue wrapped cell (o = offset of the frame)
  function batteryMesh(b, o) {
    const T = window.THREE, w = b.x1 - b.x0, l = b.y1 - b.y0, t = b.z1 - b.z0, shape = b.shape || b.kind;
    let geo, mat;
    if (shape === 'coin') { geo = new T.CylinderGeometry(w / 2, w / 2, t, 48); geo.rotateX(Math.PI / 2); mat = new T.MeshStandardMaterial({ color: 0xc9ccd1, roughness: 0.3, metalness: 0.85 }); }
    else if (shape === 'cyl') { geo = new T.CylinderGeometry(t / 2, t / 2, Math.max(w, l), 40); if (w > l) geo.rotateZ(Math.PI / 2); mat = new T.MeshStandardMaterial({ color: 0x2f6fd0, roughness: 0.45, metalness: 0.2 }); }
    else { geo = new T.BoxGeometry(w, l, t); mat = new T.MeshStandardMaterial({ color: 0xb8bcc4, roughness: 0.35, metalness: 0.7 }); }
    const m = new T.Mesh(geo, mat); m.position.set((b.x0 + b.x1) / 2 + o[0], (b.y0 + b.y1) / 2 + o[1], (b.z0 + b.z1) / 2 + o[2]); m.userData.battery = true;
    return m;
  }
  function syncToolbar() {
    const m = Enclosure.mode();
    document.querySelectorAll('#encMode button').forEach(b => b.classList.toggle('on', b.dataset.m === m));
    $('#encCodeBtn').classList.toggle('hidden', m !== 'custom');
    $('#encLid').textContent = m === 'custom' ? 'Covers' : 'Lid';
    $('#encLid').title = m === 'custom' ? 'Show the parts that have an explode offset (lids, covers)' : 'Show the lid';
    if (m !== 'custom') $('#encCodePanel').classList.add('hidden');
  }
  function place() {
    if (!root || !ui.built) return;
    if (ui.built.custom) {
      for (const m of meshes.parts || []) {
        const p = m.userData, ex = ui.explode && p.explode ? p.explode : [0, 0, 0];
        m.position.set(ex[0], ex[1], ex[2]);
        m.visible = ui.lid || !p.explode;
        m.material.opacity = ui.xray ? 0.35 : 1; m.material.depthWrite = !ui.xray;
      }
      if (meshes.pcb) meshes.pcb.visible = ui.pcb;
      for (const m of meshes.extras || []) m.visible = ui.pcb;
      applySection(); drawOverlay(); draw(); return;
    }
    const L = ui.built.L, ex = ui.explode ? (L.P.explode || 12) + L.P.lipHeight : 0;
    if (meshes.base) { meshes.base.material.opacity = ui.xray ? 0.35 : 1; meshes.base.material.depthWrite = !ui.xray; }
    if (meshes.lid) { meshes.lid.visible = ui.lid; meshes.lid.position.z = ex; meshes.lid.material.opacity = ui.xray ? 0.35 : 1; meshes.lid.material.depthWrite = !ui.xray; }
    if (meshes.pcb) meshes.pcb.visible = ui.pcb;
    applySection(); drawOverlay(); draw();
  }
  // ---------- custom mode: free-form 3D script (shape3d.js) built in a Web Worker ----------
  let worker = null, seq = 0, lastRun = null, codeDirty = false;
  const pending = new Map();
  function getWorker() {
    if (worker) return worker;
    worker = new Worker(WORKER);
    worker.onmessage = e => {
      const p = pending.get(e.data.id); if (!p) return;
      pending.delete(e.data.id); clearTimeout(p.t);
      if (e.data.ok) p.res(e.data.r); else p.rej(Object.assign(new Error(e.data.error), { line: e.data.line, logs: e.data.logs }));
    };
    worker.onerror = e => { for (const p of pending.values()) { clearTimeout(p.t); p.rej(new Error(e.message || 'the 3D worker crashed')); } pending.clear(); worker = null; };
    return worker;
  }
  function scriptCtx() { try { return Shape3D.context(Enclosure.layout()); } catch (e) { return { pcb: null }; } }
  // build a script (cached: the same script on the same board is not rebuilt)
  function runScript(code) {
    const ctx = scriptCtx(), key = code + '\u0000' + JSON.stringify(ctx);
    if (lastRun && lastRun.key === key) return lastRun.p;
    const id = ++seq;
    const p = new Promise((res, rej) => {
      const t = setTimeout(() => { if (worker) worker.terminate(); worker = null; pending.delete(id); rej(new Error('The 3D script ran longer than 2 minutes and was stopped — use a lower resolution(), fewer hull points or fewer booleans.')); }, 120000);
      pending.set(id, { res, rej, t });
      getWorker().postMessage({ id, code, ctx, opts: { timeLimitMs: 110000 } });
    });
    lastRun = { key, p };
    ui.running = true; out();
    p.then(r => { if (lastRun && lastRun.p === p) { ui.custom = { r, ctx }; ui.running = false; ui.err = null; showCustom(true); } },
      e => { if (lastRun && lastRun.p === p) { ui.custom = { r: null, ctx, err: e }; ui.running = false; lastRun = null; showCustom(false); } });
    return p;
  }
  function setMode(m) {
    try {
      Model.mutate(() => {
        const u = { mode: m };
        if (m === 'custom' && !Enclosure.script()) u.script = Shape3D.EXAMPLES[scriptCtx().pcb ? 'box' : 'wristband'];
        Enclosure.setParams(u);
      });
      if (m === 'custom') toggleCode(true);
      dirty = true; rebuild(true);
    } catch (e) { App.toast(e.message); }
  }
  function toggleCode(on) {
    const p = $('#encCodePanel'); on = on ?? p.classList.contains('hidden');
    p.classList.toggle('hidden', !on); $('#encCodeBtn').classList.toggle('on', on);
    if (on && !codeDirty) $('#encCode').value = Enclosure.script();
    resize(); draw();
  }
  function runEditor() {
    const code = $('#encCode').value;
    codeDirty = false;
    Model.mutate(() => Enclosure.setParams({ mode: 'custom', script: code }));
    dirty = true; rebuild(false);
  }
  function out() {
    const el = $('#encOut'); if (!el) return;
    const c = ui.custom, r = c && c.r;
    let h = '';
    if (ui.running) h = '<div class="muted"><span class="spin"></span> Building the 3D model…</div>';
    else if (c && c.err) h = `<div class="bad">⚠ ${esc(c.err.message)}</div>` + (c.err.logs && c.err.logs.length ? `<pre>${esc(c.err.logs.join('\n'))}</pre>` : '');
    else if (r) {
      h = `<div class="good">✓ ${r.parts.length} part${r.parts.length > 1 ? 's' : ''} in ${(r.ms / 1000).toFixed(1)} s</div>` +
        `<table class="pins">${r.parts.map(p => `<tr><td>${esc(p.name)}</td><td>${p.size_mm.map(v => v.toFixed(1)).join(' × ')} mm</td><td>${p.volume_cm3} cm³</td><td>${p.open_edges ? '<span class="muted" title="small mesh gaps — slicers repair them">≈ closed</span>' : 'watertight'}</td></tr>`).join('')}</table>` +
        (r.report.collisions.length ? `<div class="bad">⚠ Collides with the board: ${r.report.collisions.map(x => `${esc(x.part)} ↔ ${esc(x.with)} (${x.overlap_mm3} mm³)`).join(', ')}</div>` : '') +
        ((r.report.outside || []).length ? `<div class="bad">⚠ Not inside the enclosure: ${r.report.outside.map(esc).join(', ')}</div>` : '') +
        (c.ctx.pcb && !r.report.collisions.length && !(r.report.outside || []).length ? '<div class="good">✓ Fit check: the board and every part are inside, no collisions.</div>' : '') +
        (r.logs.length ? `<pre>${esc(r.logs.join('\n'))}</pre>` : '');
    }
    el.innerHTML = h;
  }
  function showCustom(fit) {
    out();
    const c = ui.custom, r = c && c.r;
    if (!r) { msg(c && c.err ? '3D script error — see the editor' : ''); ui.built = null; if (root) { while (root.children.length) root.remove(root.children[0]); draw(); } infoCustom(); return; }
    msg('');
    ui.built = { custom: true };
    infoCustom();
    if (!root) return;
    const T = window.THREE;
    while (root.children.length) root.remove(root.children[0]);
    const palette = [0x4f8fd9, 0x9fd27a, 0xe0a050, 0xc080e0, 0x60c0c0];
    meshes.parts = r.parts.map((p, i) => {
      const g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(p.pos, 3)); g.setAttribute('normal', new T.BufferAttribute(p.nor, 3));
      let col; try { col = new T.Color(p.color || palette[i % palette.length]); } catch (e) { col = new T.Color(palette[i % palette.length]); }
      const m = withCap(new T.Mesh(g, new T.MeshStandardMaterial({ color: col, roughness: 0.6, metalness: 0.05, transparent: true, opacity: 1, side: T.DoubleSide })));
      Object.assign(m.userData, p); root.add(m); return m;
    });
    meshes.extras = (r.extras || []).filter(x => x.kind === 'battery').map(b => { const m = batteryMesh(b, [0, 0, 0]); root.add(m); return m; });
    meshes.pcb = null;
    if (c.ctx.pcb) { try { const L = Enclosure.layout(), g = pcbGroup(L); g.position.set(-c.ctx.origin[0], -c.ctx.origin[1], -c.ctx.origin[2]); meshes.pcb = g; root.add(g); } catch (e) { } }
    if (ui.dimsFor !== r) { ui.rulers = []; ui.pendingA = null; ui.dimsFor = r; }   // a new model: old ruler points no longer apply
    ui.dims = measureModel(c.ctx.pcb ? c.ctx.pcb.thickness + 1 : null);
    if (fit || !ui.fitted) {
      const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (const p of r.parts) for (let k = 0; k < 3; k++) { b[k] = Math.min(b[k], p.bbox[k]); b[k + 3] = Math.max(b[k + 3], p.bbox[k + 3]); }
      cam.tx = (b[0] + b[3]) / 2; cam.ty = (b[1] + b[4]) / 2; cam.tz = (b[2] + b[5]) / 2; cam.r = Math.max(b[3] - b[0], b[4] - b[1], b[5] - b[2]) * 2.6; ui.fitted = true;
    }
    resize(); place();
    if (active) App.renderAll();
  }
  function infoCustom() {
    const c = ui.custom, r = c && c.r;
    const bat = r && (r.extras || []).find(x => x.kind === 'battery');
    $('#encInfo').innerHTML = r ? `<b>Custom 3D</b> · ${r.parts.map(p => `${esc(p.name)} ${p.size_mm.map(v => v.toFixed(1)).join('×')} mm`).join(' · ')}${bat ? ` · 🔋 ${esc(bat.name)} ${bat.mAh} mAh` : ''}${r.report.collisions.length ? ' · <span class="bad">⚠ collisions</span>' : ''} · <span class="muted">built in ${(r.ms / 1000).toFixed(1)} s</span><br><span class="muted">Drag to orbit · right-drag / Shift-drag to pan · wheel to zoom · ask the AI to change the design</span>`
      : `<b>Custom 3D</b> · ${ui.running ? 'building…' : 'no model yet'}`;
  }
  function rebuild(fit) {
    dirty = false;
    syncToolbar();
    if (Enclosure.mode() === 'custom') {
      if (!codeDirty && $('#encCode')) $('#encCode').value = Enclosure.script();
      const code = Enclosure.script();
      if (!code.trim()) { ui.custom = null; showCustom(false); msg('Write a 3D script (</> Script) or ask the AI, e.g. “make a wristband pod like Whoop for this PCB”'); return; }
      if (fit) ui.fitted = false;
      runScript(code).catch(() => { });
      return;
    }
    let r;
    try { r = Enclosure.build(); ui.err = null; msg(''); } catch (e) { ui.err = e.message; msg(e.message); ui.built = null; if (root) { while (root.children.length) root.remove(root.children[0]); draw(); } App.renderAll(); return; }
    const first = !ui.built; ui.built = r;
    info(r);
    if (!root) return;
    while (root.children.length) root.remove(root.children[0]);
    meshes.parts = null; ui.built.custom = false;
    meshes.base = meshFrom(r.base, 0x4f8fd9); meshes.lid = meshFrom(r.lid, 0x9fd27a); meshes.pcb = pcbGroup(r.L);
    root.add(meshes.base, meshes.lid, meshes.pcb);
    ui.rulers = []; ui.pendingA = null; ui.dims = measureModel(r.L.pcbTop + 1);
    if (first || fit) { const b = r.L.bbox; cam.tx = (b[0] + b[2]) / 2; cam.ty = (b[1] + b[3]) / 2; cam.tz = r.L.H / 2; cam.r = Math.max(b[2] - b[0], b[3] - b[1], r.L.H) * 2.4; }
    resize(); place();
    if (active) App.renderAll();
  }
  function info(r) {
    const d = Enclosure.describe(r);
    $('#encInfo').innerHTML = `<b>${d.outer_mm.join(' × ')} mm</b> · base ${d.base_height} mm + lid ${d.lid_thickness} mm · tallest part ${d.tallest_part_mm} mm · ${d.mounting_holes ? d.mounting_holes + ' screw standoffs' : d.supports + ' corner supports'} · ${d.cutouts.length} cutouts${d.battery ? ` · 🔋 ${esc(d.battery.name)} (${d.battery.place})` : ''}<br><span class="muted">Drag to orbit · right-drag / Shift-drag to pan · wheel to zoom</span>`;
  }

  // ---------- parameter panel (left Properties area) ----------
  const FIELDS = [
    ['Shell', [['wall', 'Wall'], ['floor', 'Floor'], ['clearance', 'PCB ↔ wall gap'], ['topClearance', 'Space above tallest part'], ['extraHeight', 'Extra height']]],
    ['Board support', [['standoffHeight', 'Standoff height'], ['standoffDiameter', 'Standoff Ø'], ['screwHole', 'Screw pilot hole Ø'], ['pcbThickness', 'PCB thickness']]],
    ['Lid', [['lidThickness', 'Lid thickness'], ['lidFit', 'Lid fit tolerance'], ['lipHeight', 'Lip height'], ['lipWidth', 'Lip width']]],
    ['Vents', [['ventWidth', 'Slot width'], ['ventLength', 'Slot length'], ['ventSpacing', 'Slot pitch']]],
  ];
  // battery picker: every cell of the catalogue, grouped (value = id)
  function batteryOptions(cur) {
    const groups = [['coin', 'Coin cells'], ['lipo', 'LiPo pouches'], ['cyl', 'Cylindrical Li-ion']];
    return `<option value="">None</option>` + groups.map(([k, t]) => `<optgroup label="${t}">${Enclosure.batteries({ kind: k }).map(b => `<option value="${b.id}" ${b.id === cur ? 'selected' : ''}>${esc(b.kind === 'lipo' ? b.id.replace('lipo-', 'LiPo ') : b.name.replace(/ \(.*/, ''))} · ${b.size_mm} mm · ${b.mAh} mAh${b.rechargeable ? '' : ' · primary'}</option>`).join('')}</optgroup>`).join('');
  }
  const PLACES = [['under', 'under the board'], ['beside', 'beside the board'], ['above', 'above the parts']];
  const quick = { template: 'box-rounded', shape: '', battery: '', batteryPlace: 'under', label: '' };
  function props(el) {
    const P = Enclosure.params(), S = Model.S;
    let d = null; try { d = Enclosure.describe(); } catch (e) { }
    const mode = Enclosure.mode();
    let h = `<div class="ph">Enclosure</div><div class="seg encmodeseg"><button data-m="box" class="${mode === 'box' ? 'on' : ''}">Box</button><button data-m="custom" class="${mode === 'custom' ? 'on' : ''}">Custom 3D</button></div>`;
    if (mode === 'custom') {
      const c = ui.custom, r = c && c.r;
      h += `<div class="muted small">Free-form model from a 3D script: wristbands, chest patches, clips, curved or organic cases. Describe what you need to the AI — e.g. <i>“make a Whoop-style wristband pod for this board with a USB-C opening”</i> or <i>“ECG chest patch with 3 snap-electrode holes 60 mm apart”</i> — or edit the script yourself.</div>
        <div class="row"><button id="encOpenCode">&lt;/&gt; Edit script</button></div>
        <div class="ph small">Quick design (no code)</div><div class="enc-tpl"><div class="encgrid">
          <label>Template<select id="qTpl">${['Wrist', 'Chest', 'Body', 'Box'].map(cat => `<optgroup label="${cat}">${Shape3D.TEMPLATES.filter(t => t.cat === cat).map(t => `<option value="${t.id}" ${t.id === quick.template ? 'selected' : ''} title="${esc(t.desc)}">${esc(t.name)}</option>`).join('')}</optgroup>`).join('')}</select></label>
          <label>Shape<select id="qShape"><option value="">template's</option>${Shape3D.PARAMS.shape.map(v => `<option ${v === quick.shape ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
          <label>Battery<select id="qBat">${batteryOptions(quick.battery)}</select></label>
          <label>Battery goes<select id="qPlace">${PLACES.map(([v, t]) => `<option value="${v}" ${v === quick.batteryPlace ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
          <label>Engraved text<input id="qLabel" maxlength="24" placeholder="e.g. NODE-01" value="${esc(quick.label)}"></label>
        </div><div class="row"><button id="qBuild" class="primary">▶ Build</button></div>
        <div class="muted small">Sized from your board. Replaces the script; built in about a second.</div></div>`;
      if (r) h += `<div class="ph small">Parts (one STL each)</div><table class="pins">${r.parts.map(p => `<tr><td>${esc(p.name)}</td><td>${p.size_mm.map(v => v.toFixed(1)).join(' × ')}</td></tr>`).join('')}</table>` +
        (r.report.collisions.length ? `<div class="bad small">⚠ ${r.report.collisions.map(x => esc(x.part + ' ↔ ' + x.with)).join(', ')}</div>` : '');
      else if (c && c.err) h += `<div class="bad small">⚠ ${esc(c.err.message)}</div>`;
      el.innerHTML = h;
      el.querySelectorAll('.encmodeseg button').forEach(b => b.onclick = () => setMode(b.dataset.m));
      $('#encOpenCode').onclick = () => toggleCode(true);
      $('#qBuild').onclick = () => {
        Object.assign(quick, { template: $('#qTpl').value, shape: $('#qShape').value, battery: $('#qBat').value, batteryPlace: $('#qPlace').value, label: $('#qLabel').value.trim() });
        const params = {}; if (quick.shape) params.shape = quick.shape; if (quick.battery) { params.battery = quick.battery; params.batteryPlace = quick.batteryPlace; } if (quick.label) params.label = quick.label;
        try { const code = Shape3D.fromTemplate(quick.template, params); codeDirty = false; Model.mutate(() => Enclosure.setParams({ mode: 'custom', script: code })); dirty = true; ui.fitted = false; rebuild(true); }
        catch (e) { App.toast(e.message); }
      };
      return true;
    }
    if (!d) { el.innerHTML = h + `<div class="muted">${esc(ui.err || 'Generate the PCB first — the enclosure is fitted to it.')}</div>`; return true; }
    h += `<div class="lcscinfo"><b>${d.outer_mm.join(' × ')} mm</b><br>PCB ${S.board.w}×${S.board.h} mm · ${(S.board.shape || { type: 'rect' }).type} outline</div>`;
    for (const [title, fs] of FIELDS) {
      h += `<div class="ph small">${title}</div><div class="encgrid">` + fs.map(([k, l]) => `<label>${l}<input data-ep="${k}" type="number" step="0.1" min="0" value="${P[k]}"></label>`).join('') + '</div>';
      if (title === 'Board support') h += `<div class="row"><button id="encHoles">${(S.pcb.holes || []).length ? '↻ Re-place' : '＋ Add'} M3 mounting holes</button>${(S.pcb.holes || []).length ? '<button id="encNoHoles" class="danger">Remove holes</button>' : ''}</div><div class="muted small">${(S.pcb.holes || []).length ? (S.pcb.holes.length + ' holes on the PCB → screw standoffs') : 'No PCB holes: the board rests on corner supports'}</div>`;
      if (title === 'Vents') h += `<label class="chk"><input type="checkbox" data-ep="vents" ${P.vents ? 'checked' : ''}> Vent slots in the lid</label>`;
    }
    h += `<div class="ph small">Battery</div><div class="encgrid">
        <label>Cell<select id="encBat">${batteryOptions(P.battery)}</select></label>
        <label>Goes<select id="encBatPlace">${PLACES.map(([v, t]) => `<option value="${v}" ${v === P.batteryPlace ? 'selected' : ''}>${t}</option>`).join('')}</select></label></div>
      <div class="muted small">${d.battery ? `🔋 ${esc(d.battery.name)} · ${d.battery.mAh} mAh — the box grows to hold it.` : 'A loose cell wired to the board (LIR / CR coin, LiPo pouch, 18650 …). Rechargeable cells need a charger IC on the PCB.'}</div>`;
    h += `<div class="ph small">Cutouts</div>
      <label class="chk"><input type="checkbox" data-ep="autoConnectorCutouts" ${P.autoConnectorCutouts ? 'checked' : ''}> Openings for edge connectors (USB, jacks…)</label>
      <label class="chk"><input type="checkbox" data-ep="autoLidHoles" ${P.autoLidHoles ? 'checked' : ''}> Lid holes above LEDs and buttons</label>
      <ul class="cutl">${d.cutouts.map(c => `<li>${c.auto ? '⚙' : '✎'} ${esc(c.side)} · ${c.shape} ${c.w}×${c.h}${c.label ? ' · ' + esc(c.label) : ''}${c.auto ? '' : ` <button class="mini-btn danger" data-rmcut="${c.index}">✕</button>`}</li>`).join('')}</ul>
      <div class="encgrid">
        <label>Side<select id="ecSide"><option>left</option><option>right</option><option>front</option><option>back</option><option>lid</option><option>floor</option></select></label>
        <label>Shape<select id="ecShape"><option value="rect">rectangle</option><option value="circle">circle</option></select></label>
        <label>Width<input id="ecW" type="number" step="0.5" value="8"></label><label>Height<input id="ecH" type="number" step="0.5" value="5"></label>
        <label>Along wall / X<input id="ecU" type="number" step="0.5" value="0"></label><label>Z / Y<input id="ecZ" type="number" step="0.5" placeholder="auto"></label>
      </div><div class="row"><button id="ecAdd">＋ Add cutout</button></div>
      <div class="muted small">Wall cutouts: position along the wall from its centre, Z from the bed (empty = 4 mm above the PCB). Lid / floor: X, Y in enclosure coordinates.</div>
      <div class="ph small">Part heights (mm)</div><table class="pins">${Object.entries(d.part_heights).map(([ref, v]) => `<tr><td>${esc(ref)}</td><td><input data-ph="${esc(ref)}" type="number" step="0.5" value="${v}" style="width:70px"></td></tr>`).join('')}</table>
      <div class="muted small">Heights are estimated from the package; change any to fit real parts.</div>`;
    el.innerHTML = h;
    el.querySelectorAll('.encmodeseg button').forEach(b => b.onclick = () => setMode(b.dataset.m));
    el.querySelectorAll('[data-ep]').forEach(i => i.onchange = () => { try { Model.mutate(() => Enclosure.setParams({ [i.dataset.ep]: i.type === 'checkbox' ? i.checked : +i.value })); } catch (e) { App.toast(e.message); } });
    el.querySelectorAll('[data-ph]').forEach(i => i.onchange = () => Model.mutate(() => Enclosure.setParams({ partHeights: { [i.dataset.ph]: i.value === '' ? null : +i.value } })));
    el.querySelectorAll('[data-rmcut]').forEach(b => b.onclick = () => Model.mutate(() => { const c = (Model.S.enclosure.cutouts || []).slice(); c.splice(+b.dataset.rmcut, 1); Model.S.enclosure = Object.assign({}, Model.S.enclosure, { cutouts: c }); }));
    $('#encBat').onchange = e => { try { Model.mutate(() => Enclosure.setParams({ battery: e.target.value })); } catch (er) { App.toast(er.message); } };
    $('#encBatPlace').onchange = e => { try { Model.mutate(() => Enclosure.setParams({ batteryPlace: e.target.value })); } catch (er) { App.toast(er.message); } };
    $('#ecAdd').onclick = () => { try { const side = $('#ecSide').value, lidish = side === 'lid' || side === 'floor'; Model.mutate(() => Enclosure.addCutout({ side, shape: $('#ecShape').value, width: +$('#ecW').value, height: +$('#ecH').value, u: +$('#ecU').value, x: +$('#ecU').value, y: $('#ecZ').value === '' ? 0 : +$('#ecZ').value, z: lidish || $('#ecZ').value === '' ? null : +$('#ecZ').value })); } catch (e) { App.toast(e.message); } };
    $('#encHoles').onclick = () => { try { const r = Model.mutate(() => Pcb.addMountingHoles({})); App.toast(`${r.holes.length} M3 mounting holes added to the PCB${r.skipped ? ` (${r.skipped} corners too crowded)` : ''} — Route the PCB again so tracks avoid them`, 6000); } catch (e) { App.toast(e.message); } };
    if ($('#encNoHoles')) $('#encNoHoles').onclick = () => Model.mutate(() => { Model.S.pcb.holes = []; });
    return true;
  }

  // ---------- exports ----------
  function exportAll(kind) {
    if (Enclosure.mode() === 'custom') return exportCustom(kind);
    if (kind !== 'scad') { App.toast('Building high-resolution STL for printing…', 20000); return new Promise(res => setTimeout(() => res(exportBox(kind)), 30)); }
    return exportBox(kind);
  }
  function exportBox(kind) {
    try {
      // STLs for a print service: rebuilt with fine curve segments (the preview uses a coarser, faster mesh)
      let out; Enclosure.setQuality('high'); try { out = Enclosure.exportFiles(); } finally { Enclosure.setQuality('preview'); }
      const { files, info } = out;
      const names = Object.keys(files);
      if (kind === 'stl') { for (const n of names.filter(n => n.endsWith('.stl'))) App.download(n, new Blob([files[n]], { type: 'model/stl' })); }
      else if (kind === 'scad') { const n = names.find(n => n.endsWith('.scad')); App.download(n, files[n], 'text/plain'); }
      else App.download((Model.S.name || 'board').replace(/[^\w.-]+/g, '_') + '-enclosure.zip', makeZip(files));
      App.toast(`Enclosure ${info.outer_mm.join(' × ')} mm exported`); return true;
    } catch (e) { App.toast(e.message); return false; }
  }
  // high-resolution rebuild of the script for the STL files (own worker; the preview stays as it is)
  let hqBusy = false;
  function buildHQ(code) {
    return new Promise((res, rej) => {
      const w = new Worker(WORKER), t = setTimeout(() => { w.terminate(); rej(new Error('high-resolution build took longer than 6 minutes')); }, 360000);
      w.onmessage = e => { clearTimeout(t); w.terminate(); e.data.ok ? res(e.data.r) : rej(new Error(e.data.error)); };
      w.onerror = e => { clearTimeout(t); w.terminate(); rej(new Error(e.message || 'worker error')); };
      w.postMessage({ id: 1, code, ctx: scriptCtx(), opts: { quality: 'high', mesh: false, check: false, timeLimitMs: 340000 } });
    });
  }
  async function exportCustom(kind) {
    const prev = ui.custom && ui.custom.r;
    if (!prev) { App.toast(ui.running ? 'Still building the 3D model — try again when it is shown' : 'Run the 3D script first'); return false; }
    let r = prev;
    if (kind !== 'scad') {
      if (hqBusy) { App.toast('High-resolution build already running…'); return false; }
      hqBusy = true; const t0 = Date.now();
      const tick = setInterval(() => App.toast(`Building high-resolution STL for printing… ${Math.round((Date.now() - t0) / 1000)} s`, 2000), 1000);
      try { r = await buildHQ(Enclosure.script()); }
      catch (e) { App.toast('High-resolution build failed (' + e.message + ') — exporting the preview mesh instead', 7000); r = prev; }
      finally { clearInterval(tick); hqBusy = false; }
    }
    const base = (Model.S.name || 'design').replace(/[^\w.-]+/g, '_'), files = {};
    for (const p of r.parts) files[`${base}-${p.name}.stl`] = p.stl;
    files[base + '-enclosure.scad'] = r.scad;
    files[base + '-enclosure-script.js'] = Enclosure.script();
    files[base + '-enclosure-README.txt'] = ['CircuitPilot custom enclosure — ' + (Model.S.name || 'design'), '', ...r.parts.map(p => `${p.name}: ${p.size_mm.join(' x ')} mm, ${p.volume_cm3} cm3`), '',
      'STL files are oriented for printing (lids/covers flipped where the script asks for it) and sit on the bed.',
      'The .scad file is equivalent OpenSCAD source; the -script.js file is the CircuitPilot 3D script (paste it into the Enclosure script editor).'].join('\n');
    if (kind === 'stl') { for (const n of Object.keys(files).filter(n => n.endsWith('.stl'))) App.download(n, new Blob([files[n]], { type: 'model/stl' })); }
    else if (kind === 'scad') App.download(base + '-enclosure.scad', r.scad, 'text/plain');
    else App.download(base + '-enclosure.zip', makeZip(files));
    App.toast(`Exported ${r.parts.length} part${r.parts.length > 1 ? 's' : ''}${r !== prev ? ` · high resolution (${r.parts.reduce((a, p) => a + p.triangles, 0).toLocaleString()} triangles)` : ''}`, 6000);
    return true;
  }
  // ---------- dimensions (overall size, wall / floor / lid thickness) and the ruler ----------
  // Measured on the meshes themselves (rays through the printed parts), so they hold for any shape: box, pod, patch.
  // The overlay lives in the scene, not under root: it is never clipped by the section or moved by explode.
  const DIM = 0xff7a1a, RUL = 0x16a3ff;
  const printed = () => ui.built && ui.built.custom ? (meshes.parts || []) : [meshes.base, meshes.lid].filter(Boolean);
  function measureModel(zRef) {
    const T = window.THREE, P = printed(); if (!P.length) return null;
    root.updateMatrixWorld(true);
    const box = new T.Box3(); for (const m of P) box.expandByObject(m);
    const size = box.getSize(new T.Vector3());
    // base = the biggest part that stays put; lid = the biggest part that lifts off in the exploded view
    const vol = m => { const b = new T.Box3().setFromObject(m), q = b.getSize(new T.Vector3()); return q.x * q.y * q.z; };
    const custom = ui.built.custom, stay = custom ? P.filter(m => !m.userData.explode) : [meshes.base], lift = custom ? P.filter(m => m.userData.explode) : [meshes.lid];
    const base = stay.sort((a, b) => vol(b) - vol(a))[0], lid = lift.sort((a, b) => vol(b) - vol(a))[0];
    const ray = new T.Raycaster();
    const hits = (mesh, o, d) => { ray.set(o, d); const keep = mesh.material.side; mesh.material.side = T.DoubleSide; const h = ray.intersectObject(mesh, false); mesh.material.side = keep; return h; };
    // where the ray enters the solid, and its thickness there measured straight through (along the surface normal:
    // a ray that meets a slanted wall would read it too thick)
    const across = (mesh, o, d) => {
      const h = hits(mesh, o, d); if (!h.length || !h[0].face) return null;
      const n = h[0].face.normal.clone().transformDirection(mesh.matrixWorld); if (n.dot(d) < 0) n.negate();
      const a = h[0].point, x = hits(mesh, a.clone().addScaledVector(n, -0.01), n).find(q => q.distance > 0.06);
      return x ? [a, x.point] : null;
    };
    const median = L => { const v = L.slice().sort((a, b) => a.t - b.t); return v.length ? v[Math.floor((v.length - 1) / 2)] : null; };
    const out = { size: [size.x, size.y, size.z], box: [box.min.toArray(), box.max.toArray()] };
    if (!base) return out;
    const bb = new T.Box3().setFromObject(base), c = bb.getCenter(new T.Vector3()), bs = bb.getSize(new T.Vector3());
    const z = zRef != null && zRef > bb.min.z && zRef < bb.max.z ? zRef : c.z;
    // walls: from the middle of the cavity outwards, in the four directions (front and right first: they face the camera)
    const walls = [];
    for (const d of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0]]) for (const f of [0, 0.18, -0.18]) {
      const o = new T.Vector3(c.x + (d[1] ? f * bs.x : 0), c.y + (d[0] ? f * bs.y : 0), z), r = across(base, o, new T.Vector3(...d));
      if (r) walls.push({ t: r[0].distanceTo(r[1]), a: r[0], b: r[1], d });
    }
    const wm = median(walls);
    if (wm) out.wall = walls.find(w => Math.abs(w.t - wm.t) < 0.05) || wm;
    // floor: straight down from the cavity; lid: straight up, off-centre (engraved text and vents sit in the middle)
    const fl = []; for (const [fx, fy] of [[0, 0], [0.2, 0.15], [-0.2, -0.15]]) { const r = across(base, new T.Vector3(c.x + fx * bs.x, c.y + fy * bs.y, z), new T.Vector3(0, 0, -1)); if (r) fl.push({ t: r[0].distanceTo(r[1]), a: r[0], b: r[1] }); }
    out.floor = fl.sort((p, q) => p.t - q.t)[0] || null;   // the thinnest point (a curved floor thickens toward the ends)
    if (lid) { const lb = new T.Box3().setFromObject(lid), lc = lb.getCenter(new T.Vector3()), ls = lb.getSize(new T.Vector3()), L = [];
      for (const [fx, fy] of [[0.28, 0.28], [-0.28, 0.28], [0.28, -0.28], [-0.28, -0.28], [0, 0.32]]) { const r = across(lid, new T.Vector3(lc.x + fx * ls.x, lc.y + fy * ls.y, Math.min(z, lb.min.z - 1)), new T.Vector3(0, 0, 1)); if (r) L.push({ t: r[0].distanceTo(r[1]), a: r[0], b: r[1] }); }
      out.lid = median(L); if (out.lid) out.lidMesh = lid; }
    return out;
  }
  // a label that keeps its size on screen (and in renders): rounded box, coloured border
  function tag(text, at, color = DIM, k = 0.03) {
    const T = window.THREE, c = document.createElement('canvas'), g = c.getContext('2d'), f = 46, font = `600 ${f}px system-ui, -apple-system, Segoe UI, sans-serif`;
    g.font = font; const w = Math.ceil(g.measureText(text).width) + 30, h = f + 24; c.width = w; c.height = h;
    const r = 14; g.beginPath(); g.moveTo(r, 2); g.lineTo(w - r, 2); g.quadraticCurveTo(w - 2, 2, w - 2, r); g.lineTo(w - 2, h - r); g.quadraticCurveTo(w - 2, h - 2, w - r, h - 2); g.lineTo(r, h - 2); g.quadraticCurveTo(2, h - 2, 2, h - r); g.lineTo(2, r); g.quadraticCurveTo(2, 2, r, 2); g.closePath();
    g.fillStyle = 'rgba(255,255,255,0.94)'; g.fill(); g.lineWidth = 4; g.strokeStyle = '#' + color.toString(16).padStart(6, '0'); g.stroke();
    g.font = font; g.fillStyle = '#1d232b'; g.textBaseline = 'middle'; g.fillText(text, 15, h / 2 + 2);
    const tex = new T.CanvasTexture(c); tex.minFilter = T.LinearFilter;
    const sp = new T.Sprite(new T.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true, sizeAttenuation: false }));
    sp.scale.set(k * w / h, k, 1); sp.position.copy(at); sp.renderOrder = 1001; return sp;
  }
  function lines(pts, color = DIM) {
    const T = window.THREE, m = new T.LineSegments(new T.BufferGeometry().setFromPoints(pts), new T.LineBasicMaterial({ color, depthTest: false, transparent: true }));
    m.renderOrder = 1000; return m;
  }
  // dimension a → b drawn at offset (a vector): extension lines from the model, the dimension line, end ticks, the label
  function dimension(a, b, off, text) {
    const T = window.THREE, g = new T.Group(), A = a.clone().add(off), B = b.clone().add(off), t = off.clone().setLength(Math.max(0.6, off.length() * 0.18));
    const ext = off.clone().setLength(off.length() + t.length());
    g.add(lines([a, a.clone().add(ext), b, b.clone().add(ext), A, B, A.clone().sub(t), A.clone().add(t), B.clone().sub(t), B.clone().add(t)]));
    g.add(tag(text, A.clone().add(B).multiplyScalar(0.5)));
    return g;
  }
  // a thickness (wall, floor, lid): a short bar across the material and a leader to a label outside it
  function thickness(a, b, dir, text) {
    const T = window.THREE, g = new T.Group(), far = b.clone().add(dir.clone().setLength(Math.max(5, (ui.dims ? Math.max(...ui.dims.size) : 40) * 0.2)));
    g.add(lines([a, b, b, far], DIM));
    g.add(tag(text, far, DIM, 0.026));
    return g;
  }
  const mm = v => (Math.round(v * 10) / 10).toFixed(1);
  function drawOverlay() {
    if (!scene) return;
    const T = window.THREE;
    if (dimsG.g) { scene.remove(dimsG.g); dimsG.g.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } }); }
    const G = dimsG.g = new T.Group(); scene.add(G);
    const D = ui.dims;
    if (ui.showDims && D && ui.built) {
      const [lo, hi] = D.box.map(v => new T.Vector3(...v)), off = Math.max(D.size[0], D.size[1], D.size[2]) * 0.14;
      if (!ui.section) {   // cut in half, the overall size lines would hang past the half that is left: thicknesses only
        G.add(dimension(new T.Vector3(lo.x, lo.y, lo.z), new T.Vector3(hi.x, lo.y, lo.z), new T.Vector3(0, -off, 0), `L ${mm(D.size[0])} mm`));
        G.add(dimension(new T.Vector3(hi.x, lo.y, lo.z), new T.Vector3(hi.x, hi.y, lo.z), new T.Vector3(off, 0, 0), `W ${mm(D.size[1])} mm`));
        G.add(dimension(new T.Vector3(lo.x, lo.y, lo.z), new T.Vector3(lo.x, lo.y, hi.z), new T.Vector3(-off * 0.7, -off * 0.7, 0), `H ${mm(D.size[2])} mm`));
      }
      if (D.wall) G.add(thickness(D.wall.a, D.wall.b, new T.Vector3(...D.wall.d).add(new T.Vector3(0, 0, 0.6)), `wall ${mm(D.wall.t)}`));
      if (D.floor) G.add(thickness(D.floor.a, D.floor.b, new T.Vector3(0.5, -0.5, -1), `floor ${mm(D.floor.t)}`));
      if (D.lid && !(ui.explode && D.lidMesh && D.lidMesh.position.lengthSq() > 0) && ui.lid) G.add(thickness(D.lid.a, D.lid.b, new T.Vector3(-0.4, -0.6, 1), `lid ${mm(D.lid.t)}`));
    }
    // ruler measurements: points, line, distance (and the run along each axis)
    const dot = p => { const s = tag('', p, RUL, 0.012); s.material.map.dispose(); s.material.map = null; s.material.color = new T.Color(RUL); return s; };
    for (const r of ui.rulers) {
      G.add(lines([r.a, r.b], RUL), dot(r.a), dot(r.b));
      const d = r.b.clone().sub(r.a), parts = [['x', d.x], ['y', d.y], ['z', d.z]].filter(q => Math.abs(q[1]) > 0.05);
      G.add(tag(`${mm(d.length())} mm${parts.length > 1 ? '  (' + parts.map(q => 'Δ' + q[0] + ' ' + mm(Math.abs(q[1]))).join(' ') + ')' : ''}`, r.a.clone().add(r.b).multiplyScalar(0.5), RUL, 0.028));
    }
    if (ui.pendingA) G.add(dot(ui.pendingA));
    dimText();
  }
  // the numbers as text too, top-left of the view
  function dimText() {
    let el = $('#encDimTxt');
    if (!el) { el = document.createElement('div'); el.id = 'encDimTxt'; el.className = 'encdims'; wrap.appendChild(el); }
    const D = ui.dims, last = ui.rulers[ui.rulers.length - 1];
    const a = D && ui.built ? `<b>${D.size.map(mm).join(' × ')} mm</b>${D.wall ? ` · wall ${mm(D.wall.t)}` : ''}${D.floor ? ` · floor ${mm(D.floor.t)}` : ''}${D.lid ? ` · lid ${mm(D.lid.t)}` : ''} mm` : '';
    const b = ui.measure ? `<div class="encruler">📏 ${ui.pendingA ? 'click the second point' : 'click a point on the model'}${last ? ` · last: <b>${mm(last.b.distanceTo(last.a))} mm</b>` : ''} · corners snap · Esc clears</div>` : '';
    el.innerHTML = a + b; el.style.display = a || b ? 'block' : 'none';
  }
  function setMeasure(on) {
    ui.measure = on; ui.pendingA = null; if (!on) ui.rulers = [];
    $('#encMeasure').classList.toggle('on', on); if (renderer) renderer.domElement.style.cursor = on ? 'crosshair' : '';
    drawOverlay(); draw();
  }
  // a point on what is shown (parts, board, battery), snapped to the nearest corner of the triangle within 10 px
  function pick(e) {
    const T = window.THREE, el = renderer.domElement, rc = el.getBoundingClientRect(), ndc = new T.Vector2((e.clientX - rc.left) / rc.width * 2 - 1, -(e.clientY - rc.top) / rc.height * 2 + 1);
    const ray = new T.Raycaster(); ray.setFromCamera(ndc, camera);
    const L = []; root.traverse(m => { if (m.isMesh && !m.userData.cap) { let v = true; for (let q = m; q; q = q.parent) if (!q.visible) v = false; if (v) L.push(m); } });
    const sides = L.map(m => m.material.side); L.forEach(m => { m.material.side = T.DoubleSide; });
    let hs = ray.intersectObjects(L, false);
    L.forEach((m, i) => { m.material.side = sides[i]; });
    if (ui.section) hs = hs.filter(h => clipPlane().distanceToPoint(h.point) >= -1e-6);
    const h = hs[0]; if (!h) return;
    let p = h.point.clone();
    if (h.face) {
      const pos = h.object.geometry.attributes.position, best = { d: 10, v: null };
      for (const i of [h.face.a, h.face.b, h.face.c]) {
        const v = new T.Vector3().fromBufferAttribute(pos, i).applyMatrix4(h.object.matrixWorld), s = v.clone().project(camera);
        const d = Math.hypot((s.x - ndc.x) * rc.width / 2, (s.y - ndc.y) * rc.height / 2); if (d < best.d) { best.d = d; best.v = v; }
      }
      if (best.v) p = best.v;
    }
    if (!ui.pendingA) ui.pendingA = p; else { ui.rulers.push({ a: ui.pendingA, b: p }); ui.pendingA = null; }
    drawOverlay(); draw();
  }
  const dimsG = { g: null };
  // camera directions (orbit angles th / ph) for the named views
  const ANGLES = { iso: [-1.0, 1.05], top: [-Math.PI / 2, 0.02], bottom: [-Math.PI / 2, Math.PI - 0.02], front: [-Math.PI / 2, Math.PI / 2], back: [Math.PI / 2, Math.PI / 2], left: [Math.PI, Math.PI / 2], right: [0, Math.PI / 2], under: [-0.9, 2.15] };
  // 4 views in one picture: angled, exploded, cut in half, from below (what the AI gets after a build; the Render button)
  async function overview(o = {}) {
    const w = o.w || 1600, h = o.h || 1100, cw = Math.round(w / 2), ch = Math.round(h / 2);
    const views = [['Angled', { angle: 'iso', dims: o.dims !== false }], ['Exploded', { angle: 'iso', explode: true }], ['Cut in half', { angle: 'iso', section: 'x', dims: o.dims !== false }], ['From below', { angle: 'under' }]];
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'); g.fillStyle = o.bg || '#ffffff'; g.fillRect(0, 0, w, h);
    let k = 0;
    for (const [label, v] of views) {
      const r = await snapshot(Object.assign({ w: cw, h: ch, bg: o.bg }, v));
      if (!r) return null;
      const img = new Image(); await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = r.url; });
      const x = (k % 2) * cw, y = Math.floor(k / 2) * ch; g.drawImage(img, x, y);
      g.font = `600 ${Math.round(ch / 22)}px system-ui, sans-serif`; g.fillStyle = '#333'; g.fillText(label, x + 12, y + Math.round(ch / 22) + 8);
      k++;
    }
    g.strokeStyle = '#ddd'; g.lineWidth = 2; g.beginPath(); g.moveTo(cw, 0); g.lineTo(cw, h); g.moveTo(0, ch); g.lineTo(w, ch); g.stroke();
    return { url: c.toDataURL('image/png'), w, h };
  }
  // PNG of the enclosure for documents (off-screen, light background); o.explode lifts the lid / covers,
  // o.angle names the camera (iso, top, bottom, front, back, left, right, under), o.section cuts it in half ('x' | 'y')
  async function snapshot(o = {}) {
    if (o.overview) return overview(o);
    const w = o.w || 1400, h = o.h || 950, bg = o.bg || '#ffffff';
    await loadThree(); const T = window.THREE;
    if (!renderer) setupScene();
    if (Enclosure.mode() === 'custom') {
      const code = Enclosure.script(); if (!code.trim()) return null;
      try { await runScript(code); } catch (e) { return null; }
      showCustom(false);
    } else { if (dirty || !ui.built || ui.built.custom) rebuild(false); }
    if (!ui.built || !root) return null;
    const keep = { cam: Object.assign({}, cam), explode: ui.explode, lid: ui.lid, xray: ui.xray, pcb: ui.pcb, section: ui.section, dims: ui.showDims }, size = renderer.getSize(new T.Vector2()), pr = renderer.getPixelRatio(), oc = renderer.getClearColor(new T.Color()).getHex(), oa = renderer.getClearAlpha();
    ui.explode = !!o.explode; ui.lid = o.lid !== false; ui.xray = false; ui.pcb = o.pcb !== false; ui.section = o.section || null; ui.showDims = !!o.dims;
    const [th, ph] = ANGLES[o.angle] || [o.th ?? -1.0, o.ph ?? 1.05]; cam.th = th; cam.ph = ph;
    place();
    const box = new T.Box3(); root.updateMatrixWorld(true); root.traverse(m => { if (m.isMesh && m.visible && !m.userData.cap) box.expandByObject(m); });
    if (box.isEmpty()) return null;
    const c = box.getCenter(new T.Vector3()), sz = box.getSize(new T.Vector3());
    renderer.setPixelRatio(1); renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setClearColor(bg, 1);
    cam.tx = c.x; cam.ty = c.y; cam.tz = c.z;
    const fov = camera.fov * Math.PI / 180, span = Math.max(sz.x, sz.y, sz.z) * (o.dims ? 1.75 : 1.45); cam.r = span / 2 / Math.tan(fov / 2);   // room for the dimension lines
    draw();
    const url = renderer.domElement.toDataURL('image/png');
    Object.assign(cam, keep.cam); ui.explode = keep.explode; ui.lid = keep.lid; ui.xray = keep.xray; ui.pcb = keep.pcb; ui.section = keep.section; ui.showDims = keep.dims;
    renderer.setPixelRatio(pr); renderer.setSize(size.x, size.y); renderer.setClearColor(oc, oa); place(); resize(); draw();
    return { url, w, h };
  }
  // 📷 Render: the finished design as a picture (4 views, or one big angled view) to look at, save or share
  async function renderDialog() {
    if (!ui.built) { App.toast('Nothing to render yet'); return; }
    let dlg = $('#encRenderDlg');
    if (!dlg) {
      dlg = document.createElement('div'); dlg.id = 'encRenderDlg'; dlg.className = 'enc-render';
      dlg.innerHTML = `<div class="er-box"><div class="er-head"><b>Render</b><span class="seg" id="erMode"><button data-v="overview" class="on">4 views</button><button data-v="iso">Angled</button><button data-v="explode">Exploded</button><button data-v="section">Cut in half</button><button data-v="top">Top</button><button data-v="under">Below</button></span>
        <label class="chk"><input type="checkbox" id="erDims" checked> Dimensions</label><label class="chk"><input type="checkbox" id="erDark"> Dark background</label><span style="flex:1"></span><button id="erSave" class="primary">Save PNG ⤓</button><button id="erClose" title="Close">✕</button></div><div class="er-img"><span class="spin"></span></div></div>`;
      wrap.parentElement.appendChild(dlg);
      dlg.addEventListener('click', e => { if (e.target === dlg) dlg.remove(); });
      $('#erClose').onclick = () => dlg.remove();
      $('#erMode').onclick = e => { const b = e.target.closest('button'); if (!b) return; dlg.querySelectorAll('#erMode button').forEach(x => x.classList.toggle('on', x === b)); draw1(); };
      $('#erDark').onchange = draw1; $('#erDims').onchange = draw1;
      $('#erSave').onclick = () => { const i = dlg.querySelector('.er-img img'); if (i) App.download(`${(Model.S.name || 'design').replace(/[^\w.-]+/g, '_')}-enclosure-${dlg.dataset.v}.png`, dataBlob(i.src)); };
    }
    async function draw1() {
      const v = dlg.querySelector('#erMode button.on').dataset.v, bg = $('#erDark').checked ? '#1b1f26' : '#ffffff', box = dlg.querySelector('.er-img');
      dlg.dataset.v = v; box.innerHTML = '<span class="spin"></span>';
      const o = { bg, w: 2400, h: 1600, dims: $('#erDims').checked };
      if (v === 'overview') o.overview = true; else if (v === 'explode') Object.assign(o, { angle: 'iso', explode: true }); else if (v === 'section') Object.assign(o, { angle: 'iso', section: 'x' }); else o.angle = v;
      try { const r = await snapshot(o); box.innerHTML = r ? `<img src="${r.url}" alt="enclosure render">` : '<div class="muted">Nothing to render</div>'; }
      catch (e) { box.innerHTML = `<div class="bad">${esc(e.message)}</div>`; }
    }
    draw1();
  }
  function dataBlob(url) { const b = atob(url.slice(url.indexOf(',') + 1)), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return new Blob([u], { type: 'image/png' }); }
  return { init, show, hide, props, ui, rebuild: () => rebuild(true), runScript, snapshot, renderDialog };
})();
