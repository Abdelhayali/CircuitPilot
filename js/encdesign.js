'use strict';
// Design editor for the enclosure (Tinkercad style): add boxes, cylinders, spheres, text, connector holes, screw bosses …
// onto the 3D model, move / turn / resize them with handles or numbers, make any shape a hole, group shapes to merge them
// (solids join, holes cut out). The list is kept in the enclosure as `shapes`; the 3D kernel applies it on top of the
// script's parts (shape3d.js applyDesign), so the STL / STEP files, the checks and the AI all see the same model.
const EncDesign = (() => {
  const $ = s => document.querySelector(s);
  const st = { on: false, sel: [], mode: 'translate', snap: 1, tc: null, pivot: null, layer: null, objs: new Map(), W: [], drag: null, clip: null };
  const D = () => Shape3D.DESIGN;
  const uid = () => 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const clone = o => JSON.parse(JSON.stringify(o));
  const r2 = v => Math.round(v * 100) / 100;
  const ICON = { box: '▢', roundbox: '▢', cylinder: '◯', cone: '△', sphere: '●', hemisphere: '◓', torus: '◎', tube: '◌', wedge: '◺', pyramid: '▲', prism: '⬡', stadium: '⬭', text: 'T', slots: '☰', honeycomb: '⬢', group: '❖' };
  const LIB_KEY = 'cp.designLibrary', CLIP_KEY = 'cp.designClipboard';
  let V = null;   // the Enclosure view's three.js scene (EncView._v())
  let tcLoad = null;

  function loadTC() {
    if (window.THREE && THREE.TransformControls) return Promise.resolve();
    if (!tcLoad) tcLoad = new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'js/vendor/TransformControls.js?v=202610290100'; s.onload = res; s.onerror = () => rej(new Error('Could not load the move / turn handles')); document.head.appendChild(s); });
    return tcLoad;
  }
  const canEdit = () => Enclosure.mode() === 'custom';
  // ---------- on / off ----------
  async function toggle(on) {
    on = on ?? !st.on;
    if (on && !canEdit()) {
      // the Design shapes go on top of a 3D script: start from the box template sized from the board
      try { Model.mutate(() => Enclosure.setParams({ mode: 'custom', script: Enclosure.script() || Shape3D.fromTemplate('box-rounded', {}) })); EncView.rebuild(); App.toast('Design works on the Custom 3D model — switched to Custom 3D (a rounded box sized from your board)', 7000); }
      catch (e) { App.toast(e.message); return; }
    }
    st.on = on; $('#encDesign').classList.toggle('on', on);
    if (!on) { detach(); clearLayer(); const p = $('#encDesignPanel'); if (p) p.remove(); V && V.draw(); return; }
    try { await loadTC(); } catch (e) { App.toast(e.message); }
    V = EncView._v(); if (!V.scene) { App.toast('The 3D view is not ready yet'); st.on = false; return; }
    st.W = clone(Enclosure.params().shapes || []);
    panel(); syncScene(); V.draw();
  }
  // ---------- the scene: a see-through preview of every shape (the real cut / merge comes with the rebuild) ----------
  function geo(it) {
    const T = THREE, t = it.type, [x, y, z] = (it.size || (D().types[t] || {}).size || [10, 10, 10]).map(v => Math.max(0.05, +v || 0.05)), seg = it.sides ? Math.max(3, Math.round(it.sides)) : 40;
    let g;
    const ext = (pts, holes, depth) => { const s = new T.Shape(pts.map(p => new T.Vector2(p[0], p[1]))); const e = new T.ExtrudeGeometry(s, { depth, bevelEnabled: false, curveSegments: 16 }); e.translate(0, 0, -depth / 2); e.rotateX(Math.PI / 2); return e; };
    switch (t) {
      case 'cylinder': case 'prism': g = new T.CylinderGeometry(0.5, 0.5, 1, t === 'prism' ? (it.sides || 6) : seg); g.rotateX(Math.PI / 2); g.scale(x, y, z); break;
      case 'tube': g = new T.CylinderGeometry(0.5, 0.5, 1, seg, 1, true); g.rotateX(Math.PI / 2); g.scale(x, y, z); break;
      case 'cone': g = new T.CylinderGeometry(0.5 * Math.max(0, Math.min(1, +it.top || 0)), 0.5, 1, seg); g.rotateX(Math.PI / 2); g.scale(x, y, z); break;
      case 'sphere': g = new T.SphereGeometry(0.5, 32, 16); g.scale(x, y, z); break;
      case 'hemisphere': g = new T.SphereGeometry(0.5, 32, 8, 0, Math.PI * 2, 0, Math.PI / 2); g.rotateX(Math.PI / 2); g.scale(x, y, 2 * z); g.translate(0, 0, -z / 2); break;
      case 'torus': { const r = Math.min(z, x / 2 - 0.01) / 2; g = new T.TorusGeometry(x / 2 - r, r, 16, 48); g.scale(1, y / x, z / (2 * r)); break; }
      case 'pyramid': g = new T.ConeGeometry(Math.SQRT1_2, 1, 4); g.rotateY(Math.PI / 4); g.rotateX(Math.PI / 2); g.scale(x, y, z); break;
      case 'wedge': g = ext([[-x / 2, -z / 2], [x / 2, -z / 2], [-x / 2, z / 2]], null, y); break;
      case 'stadium': { const r = Math.min(x, z) / 2, s = new T.Shape(); s.absarc(x / 2 - r, z / 2 - r < 0 ? 0 : z / 2 - r, r, -Math.PI / 2, Math.PI / 2, false);
        if (x >= z) { s.absarc(-x / 2 + r, 0, r, Math.PI / 2, Math.PI * 1.5, false); } else { s.absarc(0, -z / 2 + r, r, Math.PI, Math.PI * 2, false); }
        g = new T.ExtrudeGeometry(s, { depth: y, bevelEnabled: false, curveSegments: 16 }); g.translate(0, 0, -y / 2); g.rotateX(Math.PI / 2); break; }
      default: g = new T.BoxGeometry(x, y, z);
    }
    return g;
  }
  // one shape as a three.js object: position / turn / mirror as the kernel does it (mirror, scale, rotate X→Y→Z, move)
  function objOf(it, depth = 0) {
    const T = THREE, o = new T.Group();
    if (it.type === 'group') for (const c of it.children || []) { if (!c.hidden) o.add(objOf(c, depth + 1)); }
    else {
      const hole = !!it.hole, m = new T.Mesh(geo(it), new T.MeshStandardMaterial({ color: hole ? 0x9aa4b2 : (it.color || 0xf0a030), transparent: true, opacity: hole ? 0.32 : 0.3, depthWrite: false, roughness: 0.6, side: T.DoubleSide }));
      m.renderOrder = 900; o.add(m);
      const e = new T.LineSegments(new T.EdgesGeometry(m.geometry, 25), new T.LineBasicMaterial({ color: hole ? 0x5b6573 : 0xc77700, transparent: true, opacity: 0.7, depthTest: false }));
      e.renderOrder = 901; e.userData.edge = true; o.add(e);
    }
    const mr = it.mirror || [0, 0, 0], sc = it.type === 'group' && it.scale ? it.scale : [1, 1, 1];
    o.scale.set((mr[0] ? -1 : 1) * sc[0], (mr[1] ? -1 : 1) * sc[1], (mr[2] ? -1 : 1) * sc[2]);
    const r = (it.rot || [0, 0, 0]).map(v => v * Math.PI / 180); o.rotation.set(r[0], r[1], r[2], 'ZYX');
    o.position.set(...(it.pos || [0, 0, 0]));
    if (!depth) o.userData.item = it.id;
    return o;
  }
  function clearLayer() { if (st.layer && V) { V.scene.remove(st.layer); st.layer.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); } st.layer = null; st.objs.clear(); }
  function syncScene() {
    if (!st.on || !V) return;
    detach(); clearLayer();
    const T = THREE, L = st.layer = new T.Group(); V.scene.add(L);
    // workplane grid under the model
    const box = new T.Box3(); V.root.traverse(m => { if (m.isMesh && m.visible && !m.userData.cap) box.expandByObject(m); });
    const zb = box.isEmpty() ? 0 : box.min.z, span = box.isEmpty() ? 100 : Math.max(60, Math.ceil(Math.max(box.max.x - box.min.x, box.max.y - box.min.y) * 2 / 10) * 10);
    const grid = new T.GridHelper(span, span / Math.max(1, st.snap >= 1 ? 5 : 1), 0x6c7684, 0x3a414c); grid.rotation.x = Math.PI / 2; grid.position.set(box.isEmpty() ? 0 : (box.min.x + box.max.x) / 2, box.isEmpty() ? 0 : (box.min.y + box.max.y) / 2, zb - 0.02);
    grid.material.transparent = true; grid.material.opacity = 0.35; grid.userData.grid = true; L.add(grid); st.zFloor = zb;
    for (const it of st.W) {
      if (it.hidden) continue;
      const o = objOf(it); L.add(o); st.objs.set(it.id, o);
      // array copies: ghosts only
      const a = it.array; if (a && a.n) { const n = a.n.map(v => Math.max(1, Math.round(v || 1))), s = a.step || [10, 10, 10];
        for (let i = 0; i < n[0]; i++) for (let j = 0; j < n[1]; j++) for (let k = 0; k < n[2]; k++) { if (!i && !j && !k) continue; const c = objOf(it); c.userData.item = it.id; c.userData.copy = true; c.position.x += s[0] * i; c.position.y += s[1] * j; c.position.z += s[2] * k; L.add(c); } }
    }
    highlight(); attach();
  }
  function highlight() {
    for (const [id, o] of st.objs) {
      const on = st.sel.includes(id);
      o.traverse(m => { if (m.isMesh) m.material.opacity = on ? 0.55 : (m.material.color.getHex() === 0x9aa4b2 ? 0.32 : 0.22); if (m.isLineSegments) { m.material.color.setHex(on ? 0x16a3ff : (m.material.userData.base ?? (m.material.userData.base = m.material.color.getHex()))); m.material.opacity = on ? 1 : 0.6; } });
    }
  }
  // ---------- handles (move / turn / resize) ----------
  function ensureTC() {
    if (st.tc || !THREE.TransformControls) return st.tc;
    const tc = st.tc = new THREE.TransformControls(V.camera, V.renderer.domElement);
    tc.setSize(0.9); tc.addEventListener('change', () => V.draw());
    tc.addEventListener('mouseDown', () => { st.drag = startDrag(); });
    tc.addEventListener('objectChange', () => dragMove());
    tc.addEventListener('mouseUp', () => { const d = st.drag; st.drag = null; if (d) { st.drag = d; endDrag(); st.drag = null; } if (st.later) { st.later = false; refresh(); } });
    st.pivot = new THREE.Object3D(); V.scene.add(st.pivot);
    applySnap();
    return tc;
  }
  function applySnap() { const tc = st.tc; if (!tc) return; tc.setTranslationSnap(st.snap || null); tc.setRotationSnap(st.snap ? 15 * Math.PI / 180 : null); tc.setScaleSnap(st.snap ? 0.05 : null); tc.setMode(st.mode); tc.setSpace(st.mode === 'scale' ? 'local' : 'world'); }
  function detach() { if (st.tc) { st.tc.detach(); if (st.tc.parent) st.tc.parent.remove(st.tc); } }
  function attach() {
    if (!st.on || !st.sel.length || !ensureTC()) { detach(); V && V.draw(); return; }
    const objs = st.sel.map(id => st.objs.get(id)).filter(Boolean); if (!objs.length) { detach(); return; }
    let target = objs[0];
    if (objs.length > 1) { const c = new THREE.Vector3(); objs.forEach(o => c.add(o.position)); c.multiplyScalar(1 / objs.length); st.pivot.position.copy(c); st.pivot.rotation.set(0, 0, 0); st.pivot.scale.set(1, 1, 1); st.pivot.updateMatrixWorld(true); target = st.pivot; if (st.mode === 'scale') { st.mode = 'translate'; } }
    applySnap(); st.tc.attach(target); if (!st.tc.parent) V.scene.add(st.tc);
    V.draw();
  }
  function startDrag() {
    const objs = st.sel.map(id => st.objs.get(id)).filter(Boolean);
    st.pivot.updateMatrixWorld(true);
    return { multi: objs.length > 1, objs, M0: objs.map(o => o.matrix.clone()), P0inv: st.pivot.matrixWorld.clone().invert() };
  }
  function dragMove() {
    const d = st.drag; if (!d || !d.multi) return;
    st.pivot.updateMatrixWorld(true);
    const Dm = st.pivot.matrixWorld.clone().multiply(d.P0inv);
    d.objs.forEach((o, i) => { const m = Dm.clone().multiply(d.M0[i]); m.decompose(o.position, o.quaternion, o.scale); });
  }
  function endDrag() {
    const d = st.drag;
    for (const o of d.objs) {
      const it = st.W.find(x => x.id === o.userData.item); if (!it) continue;
      it.pos = o.position.toArray().map(r2);
      const e = new THREE.Euler().setFromQuaternion(o.quaternion, 'ZYX'); it.rot = [e.x, e.y, e.z].map(v => Math.round(v * 1800 / Math.PI) / 10).map(v => Object.is(v, -0) ? 0 : v);
      const s = o.scale.toArray(), mr = s.map(v => v < 0 ? 1 : 0);
      it.mirror = mr.some(v => v) ? mr : undefined;
      if (it.type === 'group') { const k = s.map(Math.abs); it.scale = k.every(v => Math.abs(v - 1) < 1e-6) ? undefined : k.map(v => Math.round(v * 1000) / 1000); }
      else { const k = s.map(Math.abs); if (k.some(v => Math.abs(v - 1) > 1e-6)) it.size = (it.size || D().types[it.type].size).map((v, i) => Math.max(0.1, r2(snapLen(v * k[i])))); }
      if (!it.mirror) delete it.mirror; if (!it.scale) delete it.scale;
    }
    commit(true);
  }
  const snapLen = v => st.snap >= 0.5 ? Math.max(st.snap, Math.round(v / st.snap) * st.snap) : v;
  // ---------- saving: one undo step per change; the model rebuilds itself (the Enclosure view listens to the project) ----------
  let pendingRedraw = false;
  function commit(keepScene) {
    try { Model.mutate(() => Enclosure.setParams({ shapes: st.W })); } catch (e) { App.toast(e.message); return; }
    if (!keepScene) syncScene(); else { pendingRedraw = true; syncScene(); }
    panel();
  }
  // the project changed elsewhere (undo / redo, the AI, another tab): take its list
  function reload() {
    if (!st.on) return;
    const cur = JSON.stringify(Enclosure.params().shapes || []);
    if (cur === JSON.stringify(st.W)) return;
    st.W = JSON.parse(cur); st.sel = st.sel.filter(id => st.W.some(x => x.id === id)); syncScene(); panel();
  }
  // after a rebuild of the model: the grid follows the model, the targets list gets the new parts
  function refresh() { if (!st.on) return; if (st.tc && st.tc.dragging) { st.later = true; return; } V = EncView._v(); syncScene(); panel(); }
  // ---------- picking ----------
  function busy() { return !!(st.on && st.tc && (st.tc.dragging || st.tc.axis)); }
  function click(e) {
    if (!st.on || !st.layer) return false;
    const T = THREE, el = V.renderer.domElement, rc = el.getBoundingClientRect(), ndc = new T.Vector2((e.clientX - rc.left) / rc.width * 2 - 1, -(e.clientY - rc.top) / rc.height * 2 + 1);
    const ray = new T.Raycaster(); ray.setFromCamera(ndc, V.camera);
    const L = []; st.layer.traverse(m => { if (m.isMesh) L.push(m); });
    const h = ray.intersectObjects(L, false)[0];
    let id = null; if (h) for (let o = h.object; o; o = o.parent) if (o.userData.item) { id = o.userData.item; break; }
    if (!id && !e.shiftKey) { const hp = ray.intersectObjects((V.meshes.parts || []).filter(m => m.visible && m.userData.design), false)[0]; if (hp) { const it = st.W.find(x => !x.hole && (x.name || x.type).replace(/[^\w.-]+/g, '_') === hp.object.userData.name); if (it) id = it.id; } }
    if (e.shiftKey || e.ctrlKey) { if (id) st.sel = st.sel.includes(id) ? st.sel.filter(x => x !== id) : st.sel.concat(id); }
    else st.sel = id ? [id] : [];
    highlight(); attach(); panel();
    return true;
  }
  // ---------- adding ----------
  // where the view is looking: on the model's surface under the middle of the view, else the camera target
  function dropPoint() {
    const T = THREE, ray = new T.Raycaster(); ray.setFromCamera(new T.Vector2(0, 0), V.camera);
    const L = []; V.root.traverse(m => { if (m.isMesh && m.visible && !m.userData.cap) L.push(m); });
    const sides = L.map(m => m.material.side); L.forEach(m => { m.material.side = T.DoubleSide; });
    const h = ray.intersectObjects(L, false)[0]; L.forEach((m, i) => { m.material.side = sides[i]; });
    if (h && h.face) { const n = h.face.normal.clone().transformDirection(h.object.matrixWorld); return { p: h.point, n }; }
    return { p: new T.Vector3(V.cam.tx, V.cam.ty, V.cam.tz), n: new T.Vector3(0, 0, 1) };
  }
  function add(def, extra = {}) {
    const it = Object.assign({ id: uid() }, clone(def), extra);
    if (!it.size) it.size = (D().types[it.type] || {}).size || [10, 10, 10];
    if (it.children) it.children = it.children.map(c => Object.assign({ id: uid() }, c));
    const { p, n } = dropPoint(), up = Math.abs(n.z) > 0.7;
    // a solid sits on the face it was dropped on; a hole goes halfway in (it cuts through the wall)
    const half = up ? it.size[2] / 2 : Math.abs(n.x) > Math.abs(n.y) ? it.size[0] / 2 : it.size[1] / 2;
    const off = it.hole ? 0 : half * 0.98, q = p.clone().addScaledVector(n, off);
    // holes on a side wall: turned to face the wall (cylinders, stadium openings run along the wall normal)
    if (it.hole && !up && !extra.rot && !def.rot) { const along = Math.abs(n.x) > Math.abs(n.y) ? 'x' : 'y';
      if (['cylinder', 'prism', 'cone'].includes(it.type)) it.rot = along === 'x' ? [0, 90, 0] : [90, 0, 0];
      else if (it.type === 'stadium' && along === 'x') it.rot = [0, 0, 90]; }
    it.pos = [q.x, q.y, q.z].map(v => st.snap >= 0.5 ? Math.round(v / st.snap) * st.snap : r2(v)).map(r2);
    if (!it.name) it.name = (D().types[it.type] || {}).name || it.type;
    let nm = it.name, k = 2; while (st.W.some(x => x.name === nm)) nm = it.name + ' ' + k++; it.name = nm;
    st.W.push(it); st.sel = [it.id]; commit();
  }
  // ---------- editing the selection ----------
  const selItems = () => st.W.filter(x => st.sel.includes(x.id));
  function del() { if (!st.sel.length) return; st.W = st.W.filter(x => !st.sel.includes(x.id)); st.sel = []; commit(); }
  function dup() {
    const L = selItems(); if (!L.length) return;
    const c = L.map(it => { const x = clone(it); x.id = uid(); x.pos = x.pos.map((v, i) => i < 2 ? r2(v + Math.max(2, st.snap * 5)) : v); x.name = it.name + ' copy'; reid(x); return x; });
    st.W.push(...c); st.sel = c.map(x => x.id); commit();
  }
  const reid = x => { x.id = uid(); (x.children || []).forEach(reid); };
  // group: solids join, holes cut out of them — one new shape (Tinkercad's Group). Children keep their place.
  function group() {
    const L = selItems(); if (L.length < 2) { App.toast('Select 2 or more shapes (Shift-click) to group them'); return; }
    const c = [0, 1, 2].map(k => r2(L.reduce((a, x) => a + x.pos[k], 0) / L.length));
    const g = { id: uid(), type: 'group', name: 'Group', target: L.find(x => !x.hole)?.target || 'new', color: L.find(x => !x.hole && x.color)?.color,
      children: L.map(x => Object.assign(clone(x), { pos: x.pos.map((v, k) => r2(v - c[k])), target: undefined })), pos: c };
    if (L.every(x => x.hole)) { g.hole = true; g.children.forEach(x => { x.hole = false; }); }
    let nm = 'Group', k = 2; while (st.W.some(x => x.name === nm)) nm = 'Group ' + k++; g.name = nm;
    const first = st.W.findIndex(x => st.sel.includes(x.id));
    st.W = st.W.filter(x => !st.sel.includes(x.id)); st.W.splice(Math.min(first, st.W.length), 0, g); st.sel = [g.id]; commit();
  }
  // ungroup: each child back in the list with the group's move / turn / scale / mirror applied
  function ungroup() {
    const L = selItems().filter(x => x.type === 'group'); if (!L.length) { App.toast('Select a group to ungroup'); return; }
    const T = THREE, out = [];
    for (const g of L) {
      const G = objOf(g); G.updateMatrixWorld(true);
      const kids = (g.children || []).map(c => {
        const x = clone(c); reid(x);
        const o = objOf(c, 1); o.updateMatrix(); const m = G.matrixWorld.clone().multiply(o.matrix), p = new T.Vector3(), q = new T.Quaternion(), s = new T.Vector3(); m.decompose(p, q, s);
        x.pos = p.toArray().map(r2); const e = new T.Euler().setFromQuaternion(q, 'ZYX'); x.rot = [e.x, e.y, e.z].map(v => Math.round(v * 1800 / Math.PI) / 10);
        const k = s.toArray(), mr = k.map(v => v < 0 ? 1 : 0); if (mr.some(v => v)) x.mirror = mr; else delete x.mirror;
        if (x.type === 'group') { const a = k.map(Math.abs); if (a.some(v => Math.abs(v - 1) > 1e-6)) x.scale = a; } else x.size = (x.size || D().types[x.type].size).map((v, i) => r2(v * Math.abs(k[i])));
        if (g.hole) x.hole = true; x.target = x.hole ? (g.hole ? g.target : g.target && g.target !== 'new' ? g.target : 'all') : g.target; if (!x.hole && g.color && !x.color) x.color = g.color;
        return x;
      });
      const i = st.W.indexOf(g); st.W.splice(i, 1, ...kids); out.push(...kids.map(x => x.id));
    }
    st.sel = out; commit();
  }
  function mirror(k) { for (const it of selItems()) { const m = it.mirror || [0, 0, 0]; m[k] = m[k] ? 0 : 1; it.mirror = m.some(v => v) ? m : undefined; if (!it.mirror) delete it.mirror; } commit(); }
  function setHole(v) { for (const it of selItems()) { it.hole = v; if (v && (!it.target || it.target === 'new')) it.target = 'all'; if (!v && it.target === 'all') it.target = 'new'; } commit(); }
  // align the selection on an axis: min / centre / max of the first selected shape's box (Tinkercad's Align)
  function boxOf(id) { const o = st.objs.get(id); return o ? new THREE.Box3().setFromObject(o) : null; }
  function align(k, how) {
    const L = selItems(); if (L.length < 2) { App.toast('Select 2 or more shapes to align them'); return; }
    const ax = 'xyz'[k], ref = boxOf(L[0].id); if (!ref) return;
    const want = how === 'min' ? ref.min[ax] : how === 'max' ? ref.max[ax] : (ref.min[ax] + ref.max[ax]) / 2;
    for (const it of L.slice(1)) { const b = boxOf(it.id); if (!b) continue; const cur = how === 'min' ? b.min[ax] : how === 'max' ? b.max[ax] : (b.min[ax] + b.max[ax]) / 2; it.pos[k] = r2(it.pos[k] + want - cur); }
    commit();
  }
  // drop to the workplane / onto the model below (Tinkercad's D)
  function dropDown() {
    const T = THREE, L = []; V.root.traverse(m => { if (m.isMesh && m.visible && !m.userData.cap && !m.userData.design) L.push(m); });
    for (const it of selItems()) {
      const b = boxOf(it.id); if (!b) continue;
      const ray = new T.Raycaster(new T.Vector3((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, b.min.z - 0.01), new T.Vector3(0, 0, -1));
      const sides = L.map(m => m.material.side); L.forEach(m => { m.material.side = T.DoubleSide; }); const h = ray.intersectObjects(L, false)[0]; L.forEach((m, i) => { m.material.side = sides[i]; });
      const z = h ? h.point.z : st.zFloor; it.pos[2] = r2(it.pos[2] - (b.min.z - z));
    }
    commit();
  }
  function nudge(k, d) { for (const it of selItems()) it.pos[k] = r2(it.pos[k] + d); commit(); }
  // ---------- My shapes (saved in this browser, for every project) and copy / paste ----------
  const store = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } } };
  function saveToLibrary() {
    const L = selItems(); if (!L.length) { App.toast('Select the shapes to save'); return; }
    const name = prompt('Name for this shape in My shapes:', L.length === 1 ? L[0].name : 'My shape'); if (!name) return;
    let item;
    if (L.length === 1) item = clone(L[0]);
    else { const c = [0, 1, 2].map(k => L.reduce((a, x) => a + x.pos[k], 0) / L.length); item = { type: 'group', children: L.map(x => Object.assign(clone(x), { pos: x.pos.map((v, k) => r2(v - c[k])) })) }; }
    delete item.pos; item.name = name;
    const lib = store.get(LIB_KEY, []); lib.push({ name, item }); store.set(LIB_KEY, lib); panel(); App.toast(`Saved “${name}” to My shapes`);
  }
  function copy() { const L = selItems(); if (!L.length) return; store.set(CLIP_KEY, L.map(clone)); App.toast(`Copied ${L.length} shape${L.length > 1 ? 's' : ''}`, 2000); }
  function paste() { const L = store.get(CLIP_KEY, []); if (!L.length) return; const c = L.map(x => { const y = clone(x); reid(y); y.pos = (y.pos || [0, 0, 0]).map((v, i) => i < 2 ? r2(v + 5) : v); return y; }); st.W.push(...c); st.sel = c.map(x => x.id); commit(); }
  // ---------- the panel ----------
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function partNames() { const r = V && V.ui.custom && V.ui.custom.r; return r ? r.parts.filter(p => p.kind === 'print' && !p.design).map(p => p.name) : []; }
  function num(id, v, step = 0.5, title = '') { return `<input data-f="${id}" type="number" step="${step}" value="${v == null ? '' : r2(v)}" title="${esc(title)}">`; }
  function panel() {
    if (!st.on) return;
    let p = $('#encDesignPanel');
    if (!p) { p = document.createElement('div'); p.id = 'encDesignPanel'; p.className = 'enc-design'; V.wrap.appendChild(p); p.addEventListener('mousedown', e => e.stopPropagation()); }
    const L = selItems(), it = L.length === 1 ? L[0] : null, T = D().types, lib = store.get(LIB_KEY, []);
    const typeBtns = Object.entries(T).map(([k, d]) => `<button data-add="${k}" title="${esc(d.name)}${d.hole ? ' (a hole)' : ''}"><span>${ICON[k] || '■'}</span>${esc(d.name.replace(' (stadium)', ''))}</button>`).join('');
    let h = `<div class="ed-head"><b>✎ Design</b><span class="seg" id="edMode">${[['translate', '✥', 'Move (W)'], ['rotate', '⟳', 'Turn (E)'], ['scale', '⤢', 'Resize (R)']].map(([m, i, t]) => `<button data-m="${m}" class="${st.mode === m ? 'on' : ''}" title="${t}">${i}</button>`).join('')}</span>
      <select id="edSnap" title="Snap grid (mm); turning snaps to 15°">${[0, 0.1, 0.5, 1, 2, 5].map(v => `<option value="${v}" ${v === st.snap ? 'selected' : ''}>${v ? 'snap ' + v : 'no snap'}</option>`).join('')}</select><button id="edClose" title="Close the Design editor">✕</button></div>
      <details class="ed-sec" open><summary>Add a shape</summary><div class="ed-add">${typeBtns}</div>
      <div class="row"><select id="edPreset"><option value="">Ready parts…</option>${Object.entries(D().presets).map(([k, d]) => `<option value="${k}">${esc(d.name)}${d.hole ? ' (hole)' : ''}</option>`).join('')}</select>
      <select id="edLib"><option value="">My shapes…</option>${lib.map((x, i) => `<option value="${i}">${esc(x.name)}</option>`).join('')}${lib.length ? '<option value="-1">— remove one…</option>' : ''}</select></div>
      <div class="muted small">Lands where the view is looking, on the model's surface. Holes cut every printed part unless you pick one.</div></details>`;
    h += `<details class="ed-sec" open><summary>Shapes (${st.W.length})</summary><ul class="ed-list">${st.W.map(x => `<li data-id="${x.id}" class="${st.sel.includes(x.id) ? 'on' : ''} ${x.hidden ? 'off' : ''}"><button class="mini-btn" data-vis="${x.id}" title="Show / hide (hidden shapes are left out of the model)">${x.hidden ? '◌' : '●'}</button><span class="ic">${ICON[x.type] || '■'}</span>${esc(x.name || x.type)}<span class="tag ${x.hole ? 'hole' : 'solid'}">${x.hole ? 'hole' : 'solid'}</span></li>`).join('') || '<li class="muted">No shapes yet — add one above.</li>'}</ul></details>`;
    if (it) {
      const d = T[it.type] || {}, tg = it.target || (it.hole ? 'all' : 'new'), names = partNames();
      h += `<details class="ed-sec" open><summary>${ICON[it.type] || ''} ${esc(it.name)}</summary>
        <label>Name<input data-f="name" value="${esc(it.name)}"></label>
        <div class="seg ed-sh"><button data-hole="0" class="${it.hole ? '' : 'on'}">■ Solid</button><button data-hole="1" class="${it.hole ? 'on hole' : ''}">▨ Hole</button></div>
        <label>${it.hole ? 'Cuts' : 'Joins'}<select data-f="target">${it.hole ? `<option value="all" ${tg === 'all' ? 'selected' : ''}>every printed part</option>` : `<option value="new" ${tg === 'new' ? 'selected' : ''}>nothing — its own part</option>`}${names.map(n => `<option value="${esc(n)}" ${tg === n ? 'selected' : ''}>${it.hole ? 'only ' : ''}${esc(n)}</option>`).join('')}</select></label>
        <div class="ed-grid"><span>Position</span>${num('pos.0', it.pos[0], st.snap || 0.1, 'X')}${num('pos.1', it.pos[1], st.snap || 0.1, 'Y')}${num('pos.2', it.pos[2], st.snap || 0.1, 'Z')}
        ${it.type === 'group' ? `<span>Scale</span>${num('scale.0', (it.scale || [1, 1, 1])[0], 0.05)}${num('scale.1', (it.scale || [1, 1, 1])[1], 0.05)}${num('scale.2', (it.scale || [1, 1, 1])[2], 0.05)}` : `<span>Size</span>${num('size.0', it.size[0], 0.1, 'X')}${num('size.1', it.size[1], 0.1, 'Y')}${num('size.2', it.size[2], 0.1, 'Z')}`}
        <span>Turn °</span>${num('rot.0', (it.rot || [0, 0, 0])[0], 15, 'about X')}${num('rot.1', (it.rot || [0, 0, 0])[1], 15, 'about Y')}${num('rot.2', (it.rot || [0, 0, 0])[2], 15, 'about Z')}</div>
        <div class="ed-grid2">${'r' in d || it.type === 'roundbox' ? `<label>Edge radius${num('r', it.r ?? d.r ?? 0, 0.1)}</label>` : ''}${['cylinder', 'cone', 'prism', 'tube', 'sphere', 'hemisphere'].includes(it.type) ? `<label>Sides${num('sides', it.sides ?? (it.type === 'prism' ? 6 : ''), 1, 'empty = smooth')}</label>` : ''}${it.type === 'cone' ? `<label>Top Ø ratio${num('top', it.top ?? 0, 0.05)}</label>` : ''}${it.type === 'tube' ? `<label>Wall${num('wall', it.wall ?? 1.6, 0.1)}</label>` : ''}${it.type === 'slots' ? `<label>Slots${num('n', it.n ?? 5, 1)}</label>` : ''}${it.type === 'honeycomb' ? `<label>Cell${num('cell', it.cell ?? 4, 0.5)}</label>` : ''}${it.type === 'text' ? `<label class="wide">Text<input data-f="text" value="${esc(it.text ?? 'TEXT')}" maxlength="40"></label>` : ''}${!it.hole ? `<label>Colour<input data-f="color" type="color" value="${esc(/^#[0-9a-f]{6}$/i.test(it.color || '') ? it.color : '#e8a33d')}"></label>` : ''}</div>
        <div class="row"><span class="muted small">Mirror</span><button data-mir="0">X</button><button data-mir="1">Y</button><button data-mir="2">Z</button><span class="muted small">Copies</span>${num('array.n.0', (it.array && it.array.n || [1, 1, 1])[0], 1, 'copies along X')}${num('array.n.1', (it.array && it.array.n || [1, 1, 1])[1], 1, 'copies along Y')}${num('array.n.2', (it.array && it.array.n || [1, 1, 1])[2], 1, 'copies along Z')}</div>
        ${it.array && it.array.n && it.array.n.some(v => v > 1) ? `<div class="ed-grid"><span>Copy step</span>${num('array.step.0', (it.array.step || [10, 10, 10])[0], 0.5)}${num('array.step.1', (it.array.step || [10, 10, 10])[1], 0.5)}${num('array.step.2', (it.array.step || [10, 10, 10])[2], 0.5)}</div>` : ''}
      </details>`;
    } else if (L.length > 1) {
      h += `<details class="ed-sec" open><summary>${L.length} shapes selected</summary>
        <div class="ed-align">${['X', 'Y', 'Z'].map((a, k) => `<span>${a}</span><button data-al="${k}:min" title="align ${a} minimum">⇤</button><button data-al="${k}:mid" title="centre on ${a}">↔</button><button data-al="${k}:max" title="align ${a} maximum">⇥</button>`).join('')}</div>
        <div class="seg ed-sh"><button data-hole="0">■ All solid</button><button data-hole="1">▨ All holes</button></div></details>`;
    }
    h += `<div class="ed-actions"><button id="edGroup" title="Merge: solids join, holes cut (Ctrl+G)" ${L.length > 1 ? '' : 'disabled'}>❖ Group</button><button id="edUngroup" title="Ctrl+Shift+G" ${L.some(x => x.type === 'group') ? '' : 'disabled'}>Ungroup</button><button id="edDup" title="Ctrl+D" ${L.length ? '' : 'disabled'}>⧉ Duplicate</button><button id="edDrop" title="Drop onto the model / workplane below (D)" ${L.length ? '' : 'disabled'}>⤓ Drop</button><button id="edSave" title="Save to My shapes (all projects)" ${L.length ? '' : 'disabled'}>★ Save</button><button id="edDel" class="danger" title="Delete" ${L.length ? '' : 'disabled'}>✕</button></div>
      <div class="muted small ed-keys">Click a shape to select, Shift-click for more · W / E / R move · turn · resize · H hole · D drop · arrows nudge (PgUp / PgDn: Z) · Ctrl+C / V · Ctrl+Z undo</div>`;
    p.innerHTML = h;
    // events
    p.querySelector('#edClose').onclick = () => toggle(false);
    p.querySelectorAll('#edMode button').forEach(b => b.onclick = () => setMode(b.dataset.m));
    p.querySelector('#edSnap').onchange = e => { st.snap = +e.target.value; applySnap(); };
    p.querySelectorAll('[data-add]').forEach(b => b.onclick = () => { const d = T[b.dataset.add]; add(Object.assign({ type: b.dataset.add }, clone(d), { name: d.name })); });
    p.querySelector('#edPreset').onchange = e => { const d = D().presets[e.target.value]; if (d) add(clone(d)); };
    p.querySelector('#edLib').onchange = e => {
      const v = +e.target.value, lib = store.get(LIB_KEY, []); if (e.target.value === '') return;
      if (v === -1) { const n = prompt('Remove which shape? Type its name:\n' + lib.map(x => x.name).join('\n')); const i = lib.findIndex(x => x.name === n); if (i >= 0) { lib.splice(i, 1); store.set(LIB_KEY, lib); } panel(); return; }
      if (lib[v]) { const x = clone(lib[v].item); reid(x); add(x); }
    };
    p.querySelectorAll('.ed-list li[data-id]').forEach(li => li.onclick = e => { if (e.target.closest('[data-vis]')) return; const id = li.dataset.id; if (e.shiftKey || e.ctrlKey) st.sel = st.sel.includes(id) ? st.sel.filter(x => x !== id) : st.sel.concat(id); else st.sel = [id]; highlight(); attach(); panel(); });
    p.querySelectorAll('[data-vis]').forEach(b => b.onclick = () => { const x = st.W.find(q => q.id === b.dataset.vis); if (x) { x.hidden = !x.hidden || undefined; if (!x.hidden) delete x.hidden; commit(); } });
    p.querySelectorAll('[data-hole]').forEach(b => b.onclick = () => setHole(b.dataset.hole === '1'));
    p.querySelectorAll('[data-mir]').forEach(b => b.onclick = () => mirror(+b.dataset.mir));
    p.querySelectorAll('[data-al]').forEach(b => b.onclick = () => { const [k, how] = b.dataset.al.split(':'); align(+k, how); });
    p.querySelectorAll('[data-f]').forEach(inp => inp.onchange = () => {
      if (!it) return;
      const path = inp.dataset.f.split('.'), raw = inp.value, v = inp.type === 'number' ? (raw === '' ? null : +raw) : raw;
      if (path[0] === 'array') { it.array = it.array || { n: [1, 1, 1], step: [10, 10, 10] }; it.array[path[1]] = it.array[path[1]] || (path[1] === 'n' ? [1, 1, 1] : [10, 10, 10]); it.array[path[1]][+path[2]] = path[1] === 'n' ? Math.max(1, Math.min(50, Math.round(v || 1))) : (v ?? 0); if (it.array.n.every(x => x === 1)) delete it.array; }
      else if (path.length === 2) { const def = path[0] === 'size' ? (it.size || T[it.type].size) : path[0] === 'scale' ? (it.scale || [1, 1, 1]) : (it[path[0]] || [0, 0, 0]); it[path[0]] = def.slice(); it[path[0]][+path[1]] = path[0] === 'size' ? Math.max(0.1, v ?? 0.1) : path[0] === 'scale' ? Math.max(0.01, v ?? 1) : (v ?? 0); }
      else if (v === null || v === '') delete it[path[0]]; else it[path[0]] = v;
      commit();
    });
    const on = (id, f) => { const b = p.querySelector(id); if (b) b.onclick = f; };
    on('#edGroup', group); on('#edUngroup', ungroup); on('#edDup', dup); on('#edDel', del); on('#edDrop', dropDown); on('#edSave', saveToLibrary);
  }
  function setMode(m) { st.mode = m; applySnap(); attach(); panel(); }
  // keys (only while the Design editor is open, the Enclosure view shown and no text field has the focus)
  function key(e) {
    if (!st.on || !V || !V.active() || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
    const c = e.ctrlKey || e.metaKey, k = e.key.toLowerCase(), big = e.shiftKey ? 10 : 1, s = (st.snap || 0.5) * big;
    let done = true;
    if (c && k === 'g') e.shiftKey ? ungroup() : group();
    else if (c && k === 'd') dup();
    else if (c && k === 'c') copy();
    else if (c && k === 'v') paste();
    else if (c) done = false;
    else if (k === 'delete' || k === 'backspace') del();
    else if (k === 'escape') { st.sel = []; highlight(); attach(); panel(); }
    else if (k === 'w') setMode('translate'); else if (k === 'e') setMode('rotate'); else if (k === 'r') setMode('scale');
    else if (k === 'h' && st.sel.length) setHole(!selItems().every(x => x.hole));
    else if (k === 'd' && st.sel.length) dropDown();
    else if (st.sel.length && e.key === 'ArrowLeft') nudge(0, -s); else if (st.sel.length && e.key === 'ArrowRight') nudge(0, s);
    else if (st.sel.length && e.key === 'ArrowUp') nudge(1, s); else if (st.sel.length && e.key === 'ArrowDown') nudge(1, -s);
    else if (st.sel.length && e.key === 'PageUp') nudge(2, s); else if (st.sel.length && e.key === 'PageDown') nudge(2, -s);
    else done = false;
    if (done) { e.preventDefault(); e.stopPropagation(); }
  }
  document.addEventListener('keydown', key, true);
  return { toggle, refresh, reload, busy, click, get on() { return st.on; } };
})();
