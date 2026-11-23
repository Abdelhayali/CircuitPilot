'use strict';
// 3D view of the PCB: solder mask / copper / pads / silkscreen textures on both sides and 3D part models —
// the real model of each part from the JLCEDA/EasyEDA Official Library (OBJ from modules.easyeda.com) when its
// footprint has one, otherwise a simple shape made from the footprint and part type.
const Pcb3D = (() => {
  const $ = s => document.querySelector(s);
  const ui = { on: false, parts: true, finish: 'enig', real: true };
  let renderer, scene, camera, root, wrap, cam = { th: -1.2, ph: 0.85, r: 120, tx: 0, ty: 0, tz: 0 }, dirty = true, timer = null, busy = false;

  function loadThree() {
    if (window.THREE) return Promise.resolve(window.THREE);
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
      s.onload = () => res(window.THREE); s.onerror = () => rej(new Error('Could not load three.js (needs internet)'));
      document.head.appendChild(s);
    });
  }
  function init() {
    wrap = $('#pcb3dView');
    wrap.innerHTML = `<div class="encmsg" id="p3msg"></div>
      <div class="p3bar"><button data-cam="top">Top</button><button data-cam="bottom">Bottom</button><button data-cam="iso">Iso</button><button id="p3parts" class="on">Parts</button><button id="p3real" class="on" title="Real 3D models from the JLCEDA/EasyEDA Official Library (simple shapes when off or when a part has none)">Real models</button>
      <select id="p3finish" title="Pad finish"><option value="enig">ENIG (gold)</option><option value="hasl">HASL (silver)</option></select><select id="p3mask" title="Solder mask colour"><option value="#1d6b38">Green</option><option value="#1a1a1a">Black</option><option value="#1c3f8f">Blue</option><option value="#8f1c1c">Red</option><option value="#e8e8e8">White</option><option value="#5a2a8a">Purple</option></select></div>
      <div class="encinfo" id="p3info">Drag to orbit · right-drag / Shift-drag to pan · wheel to zoom</div>`;
    wrap.querySelectorAll('[data-cam]').forEach(b => b.onclick = () => preset(b.dataset.cam));
    $('#p3parts').onclick = () => { ui.parts = !ui.parts; $('#p3parts').classList.toggle('on', ui.parts); if (root && root.userData.parts) root.userData.parts.visible = ui.parts; draw(); };
    $('#p3real').onclick = () => { ui.real = !ui.real; $('#p3real').classList.toggle('on', ui.real); dirty = true; rebuild(false); };
    $('#p3finish').onchange = e => { ui.finish = e.target.value; dirty = true; rebuild(false); };
    $('#p3mask').onchange = () => { dirty = true; rebuild(false); };
    Model.subscribe(kind => { if (kind === 'move') return; dirty = true; if (ui.on) { clearTimeout(timer); timer = setTimeout(() => rebuild(false), 400); } });
  }
  async function setOn(on) {
    ui.on = on;
    $('#pcb3dView').classList.toggle('hidden', !on);
    $('#btn3d').textContent = on ? '▦ 2D' : '◈ 3D';
    $('#btn3d').classList.toggle('on', on);
    if (!on) return;
    try { await loadThree(); } catch (e) { $('#p3msg').textContent = e.message; $('#p3msg').style.display = 'block'; return; }
    if (!renderer) setup();
    if (dirty) rebuild(true); else { resize(); draw(); }
  }

  // ---------- three.js ----------
  function setup() {
    const T = window.THREE;
    renderer = new T.WebGLRenderer({ antialias: true }); renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1)); const bg = () => renderer.setClearColor(getComputedStyle(document.documentElement).getPropertyValue('--view3d-pcb').trim() || '#0d1015'); bg(); window.addEventListener('themechange', () => { bg(); draw(); });
    wrap.prepend(renderer.domElement);
    scene = new T.Scene(); camera = new T.PerspectiveCamera(32, 1, 0.5, 5000); camera.up.set(0, 0, 1);
    scene.add(new T.HemisphereLight(0xffffff, 0x445566, 0.65));
    const d1 = new T.DirectionalLight(0xffffff, 0.8); d1.position.set(60, -90, 160); scene.add(d1);
    const d2 = new T.DirectionalLight(0xffffff, 0.35); d2.position.set(-120, 80, -120); scene.add(d2);
    const el = renderer.domElement; let drag = null;
    el.addEventListener('contextmenu', e => e.preventDefault());
    el.addEventListener('mousedown', e => { drag = { x: e.clientX, y: e.clientY, pan: e.button !== 0 || e.shiftKey }; });
    window.addEventListener('mouseup', () => drag = null);
    window.addEventListener('mousemove', e => {
      if (!drag || !ui.on) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
      if (drag.pan) { const k = cam.r / 600, s = Math.sin(cam.th), c = Math.cos(cam.th); cam.tx -= (dx * c + dy * s * Math.cos(cam.ph)) * k; cam.ty -= (dx * s - dy * c * Math.cos(cam.ph)) * k; cam.tz += dy * Math.sin(cam.ph) * k; }
      else { cam.th -= dx * 0.008; cam.ph = Math.max(0.02, Math.min(Math.PI - 0.02, cam.ph - dy * 0.008)); }
      draw();
    });
    el.addEventListener('wheel', e => { e.preventDefault(); cam.r = Math.max(10, Math.min(2000, cam.r * Math.exp(e.deltaY * 0.001))); draw(); }, { passive: false });
    new ResizeObserver(() => { if (ui.on) { resize(); draw(); } }).observe(wrap);
  }
  function resize() { if (!renderer) return; const r = wrap.getBoundingClientRect(); if (!r.width) return; renderer.setSize(r.width, r.height); camera.aspect = r.width / r.height; camera.updateProjectionMatrix(); }
  function draw() {
    if (!renderer) return;
    camera.position.set(cam.tx + cam.r * Math.sin(cam.ph) * Math.cos(cam.th), cam.ty + cam.r * Math.sin(cam.ph) * Math.sin(cam.th), cam.tz + cam.r * Math.cos(cam.ph));
    camera.lookAt(cam.tx, cam.ty, cam.tz); renderer.render(scene, camera);
  }
  function preset(p) {
    const S = Model.S;
    if (p === 'top') { cam.th = -Math.PI / 2; cam.ph = 0.02; } else if (p === 'bottom') { cam.th = -Math.PI / 2; cam.ph = Math.PI - 0.02; } else { cam.th = -1.2; cam.ph = 0.85; }
    cam.tx = S.board.w / 2; cam.ty = -S.board.h / 2; cam.tz = 0; cam.r = Math.max(S.board.w, S.board.h) * 2.1; draw();
  }

  // ---------- board textures (drawn as SVG in board coordinates, then rasterised) ----------
  function sideSVG(side, px) {
    const S = Model.S, idx = Model.pinIndex(), R = Pcb.rules(), w = S.board.w, h = S.board.h, L = side;
    const mask = $("#p3mask").value, cu = shade(mask, 0.32), pad = ui.finish === 'enig' ? '#d8b04a' : '#c9cdd2', silk = mask === '#e8e8e8' ? '#111' : '#f4f4f4';
    const poly = Pcb.boardPoly(), d = 'M' + poly.map(q => q.join(' ')).join('L') + 'Z', o = [];
    o.push(`<path d="${d}" fill="${mask}"/>`);
    // copper under the mask: pours, tracks, (tented) vias
    // pours with the clearance gaps around other nets' copper (as in the 2D view): that is what makes tracks show
    const pads = Pcb.placed().flatMap(c => Pcb.padsOf(c, idx)), masks = [];
    const padAt = (p, f, e) => p.shape === 'round' ? `<circle cx="${p.x}" cy="${p.y}" r="${p.w / 2 + e}" fill="${f}"/>` : `<rect x="${p.x - p.w / 2 - e}" y="${p.y - p.h / 2 - e}" width="${p.w + 2 * e}" height="${p.h + 2 * e}" rx="${p.shape === 'oval' ? Math.min(p.w, p.h) / 2 + e : e}" fill="${f}"/>`;
    (S.pcb.pours || []).forEach((pr, i) => {
      if (pr.layer !== L) return;
      const cl = Pcb.pourCl(R, pr), pp = Pcb.pourPoly(pr), m = [`<rect x="-50" y="-50" width="${w + 100}" height="${h + 100}" fill="white"/>`];
      for (const t of S.pcb.traces) if (t.layer === L && t.net !== pr.net) m.push(`<polyline points="${t.pts.map(q => q.join(',')).join(' ')}" fill="none" stroke="black" stroke-width="${t.w + 2 * cl}" stroke-linecap="round" stroke-linejoin="round"/>`);
      for (const p of pads) if (p.net !== pr.net && (p.drill || (p.layer || 'F') === L)) m.push(padAt(p, 'black', cl));
      for (const v of S.pcb.vias) if (v.net !== pr.net) m.push(`<circle cx="${v.x}" cy="${v.y}" r="${v.d / 2 + cl}" fill="black"/>`);
      for (const hh of S.pcb.holes || []) m.push(`<circle cx="${hh.x}" cy="${hh.y}" r="${hh.d / 2 + cl}" fill="black"/>`);
      m.push(`<path d="${d}" fill="none" stroke="black" stroke-width="${2 * R.edgeClearance}"/>`);
      for (const k of Pcb.keepouts()) if (k.pours && (k.layer === 'both' || k.layer === 'all' || k.layer === L)) m.push(`<path d="M${k.pts.map(q => q.join(' ')).join('L')}Z" fill="black"/>`);
      masks.push(`<mask id="pm${i}" maskUnits="userSpaceOnUse" x="-50" y="-50" width="${w + 100}" height="${h + 100}">${m.join('')}</mask>`);
      let fd; try { fd = Pcb.pourFill(pr, 'view').rings.map(rg => 'M' + rg.pts.map(q => q.join(' ')).join('L') + 'Z').join(''); } catch (e) { fd = 'M' + pp.map(q => q.join(' ')).join('L') + 'Z'; }
      if (fd) o.push(`<path d="${fd}" fill-rule="evenodd" fill="${cu}" mask="url(#pm${i})"/>`);   // live pieces only, as in the Gerber
    });
    for (const t of S.pcb.traces) if (t.layer === L) o.push(`<polyline points="${t.pts.map(q => q.join(',')).join(' ')}" fill="none" stroke="${cu}" stroke-width="${t.w}" stroke-linecap="round" stroke-linejoin="round"/>`);
    for (const v of S.pcb.vias) o.push(`<circle cx="${v.x}" cy="${v.y}" r="${v.d / 2}" fill="${cu}"/>`);
    // exposed pads (mask openings)
    for (const c of Pcb.placed()) for (const p of Pcb.padsOf(c, idx)) {
      if (!p.drill && (p.layer || 'F') !== L) continue;
      o.push(p.shape === 'round' ? `<circle cx="${p.x}" cy="${p.y}" r="${p.w / 2}" fill="${pad}"/>` : `<rect x="${p.x - p.w / 2}" y="${p.y - p.h / 2}" width="${p.w}" height="${p.h}" rx="${p.shape === 'oval' ? Math.min(p.w, p.h) / 2 : 0.05}" fill="${pad}"/>`);
      if (p.drill) o.push(`<circle cx="${p.x}" cy="${p.y}" r="${p.drill / 2}" fill="#050505"/>`);
    }
    for (const v of S.pcb.vias) o.push(`<circle cx="${v.x}" cy="${v.y}" r="${v.drill / 2}" fill="#050505"/>`);
    // silkscreen
    for (const c of Pcb.placed()) {
      if ((Pcb.isBottom(c) ? 'B' : 'F') !== L) continue;
      const b = Pcb.fpBox(c);
      o.push(`<rect x="${b[0]}" y="${b[1]}" width="${b[2] - b[0]}" height="${b[3] - b[1]}" fill="none" stroke="${silk}" stroke-width="0.15"/>`);
      const d = Pcb.pin1Dot(c); if (d) o.push(`<circle cx="${d.x}" cy="${d.y}" r="${d.d / 2}" fill="${silk}"/>`);
    }
    // part references and board name: the same strokes as the Gerber silkscreen
    for (const l of Pcb.silkLabels(L)) o.push(`<path d="${l.lines.map(pl => 'M' + pl.map(q => q.join(' ')).join('L')).join('')}" fill="none" stroke="${silk}" stroke-width="${l.w}" stroke-linecap="round" stroke-linejoin="round"/>`);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(w * px)}" height="${Math.round(h * px)}" viewBox="0 0 ${w} ${h}"><defs><clipPath id="b"><path d="${d}"/></clipPath>${masks.join('')}</defs><g clip-path="url(#b)">${o.join('')}</g></svg>`;
  }
  function shade(hex, k) { const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255, f = v => Math.max(0, Math.min(255, Math.round(v + (255 - v) * k))); return `rgb(${f(r)},${f(g)},${f(b)})`; }
  function texture(side) {
    const T = window.THREE, S = Model.S, px = Math.min(24, 4096 / Math.max(S.board.w, S.board.h));
    return new Promise(res => {
      const img = new Image(), cv = document.createElement('canvas');
      cv.width = Math.round(S.board.w * px); cv.height = Math.round(S.board.h * px);
      img.onload = () => { const g = cv.getContext('2d'); g.drawImage(img, 0, 0, cv.width, cv.height); const t = new T.CanvasTexture(cv); t.anisotropy = 8; res(t); };
      img.onerror = () => res(null);
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(sideSVG(side, px));
    });
  }

  // ---------- 3D part models ----------
  // ---------- built-in part models (when the parts library has no 3D model) ----------
  // Built in the footprint's own frame (mm, y up, origin = footprint origin) from its pads, then placed like the real
  // models (placeOnBoard). Chip resistors / capacitors get tinned ends, gull-wing ICs their leads, QFN / DFN a flat body,
  // modules a PCB with a shield, pads-only footprints (test points, electrode / wire pads) nothing.
  const matCache = new Map();
  function partModel(c, T) {
    const g = new T.Group(), fp = Lib.footprint(c.footprint); if (!fp || !fp.pads.length) return g;
    const lib = (c.lcsc && Model.S.lib[c.lcsc]) || (c.dbfp && Model.S.lib[c.dbfp]);
    const text = [c.footprint, c.value, c.type, c.name, lib && lib.name, lib && lib.package, lib && lib.footprint && lib.footprint.name, lib && lib.footprint && lib.footprint.model3d && lib.footprint.model3d.title].filter(Boolean).join(' ').toUpperCase();
    const H = Enclosure.partHeight(c, Enclosure.params());
    const mat = (color, kind) => {
      const k = color + '|' + (kind || ''); if (matCache.has(k)) return matCache.get(k);
      const m = kind === 'metal' ? new T.MeshStandardMaterial({ color, metalness: 0.3, roughness: 0.35, emissive: 0x1a1a1a })
        : kind === 'gold' ? new T.MeshStandardMaterial({ color, metalness: 0.3, roughness: 0.3, emissive: 0x2a1e00 })
        : kind === 'glass' ? new T.MeshStandardMaterial({ color, transparent: true, opacity: 0.75, roughness: 0.15 })
        : new T.MeshStandardMaterial({ color, metalness: 0.02, roughness: kind === 'gloss' ? 0.3 : 0.65 });
      matCache.set(k, m); return m;
    };
    // a box from (x0, y0) to (x1, y1) in footprint mm (y down), z0 … z1 above the board
    const box = (x0, y0, x1, y1, z0, z1, color, kind) => {
      const m = new T.Mesh(new T.BoxGeometry(Math.max(0.02, Math.abs(x1 - x0)), Math.max(0.02, Math.abs(y1 - y0)), Math.max(0.01, z1 - z0)), mat(color, kind));
      m.position.set((x0 + x1) / 2, -(y0 + y1) / 2, (z0 + z1) / 2); g.add(m); return m;
    };
    const cyl = (x, y, r, z0, z1, color, kind, seg = 24) => { const m = new T.Mesh(new T.CylinderGeometry(r, r, z1 - z0, seg), mat(color, kind)); m.rotation.x = Math.PI / 2; m.position.set(x, -y, (z0 + z1) / 2); g.add(m); return m; };
    const pads = fp.pads.map(p => { const q = (((p.rot || 0) % 180) + 180) % 180 === 90; return Object.assign({}, p, { w: q ? p.h : p.w, h: q ? p.w : p.h }); });
    const smd = pads.filter(p => !p.drill), tht = pads.filter(p => p.drill);
    const ext = ps => [Math.min(...ps.map(p => p.x - p.w / 2)), Math.min(...ps.map(p => p.y - p.h / 2)), Math.max(...ps.map(p => p.x + p.w / 2)), Math.max(...ps.map(p => p.y + p.h / 2))];
    const cy0 = fp.courtyard != null ? fp.courtyard : 0.3, ob = [fp.box[0] + cy0, fp.box[1] + cy0, fp.box[2] - cy0, fp.box[3] - cy0];   // real outline (pads + body)
    const mh = text.match(/[-_]H(\d+(?:\.\d+)?)(?=[-_ ]|$)/), pkgH = mh ? +mh[1] : null;
    const pin1 = pads.find(p => p.num === '1') || pads[0];
    const BLACK = 0x1b1b1d, TIN = 0xc9ccd0, GOLD = 0xd9b45a;
    const dot = (x, y, z) => cyl(x, y, 0.12, z, z + 0.02, 0x8a8a8a, null, 12);

    // nothing stands on the board: test points, electrode / wire / solder pads, holes
    if (H <= 0.05 || (/^LIB:/.test(c.footprint) && /TEST|\bTP\b|ELECTRODE|WIRE|SOLDER|FIDUCIAL|_PAD|PAD_|HOLE|MOUNT|ACCESS/.test(text) && !/HEADER|USB|JST|HOLDER/.test(text)) || /^TP\d/.test(c.ref)) return g;

    // ----- XIAO and other small boards / modules: PCB, metal shield, USB-C at the end nearest pin 1 -----
    if (/XIAO|SUPER ?MINI|PRO ?MICRO|ESP32|WROOM|WROVER|MINI-1|MODULE|WIFIM|NRF52|BLE ?MOD/.test(text) && pads.length >= 8) {
      const [x0, y0, x1, y1] = ob, th = 0.9, long = (x1 - x0) >= (y1 - y0);
      box(x0, y0, x1, y1, 0, th, /XIAO/.test(text) ? 0x1f2a44 : 0x1d4d8a, 'gloss');
      const usb = /XIAO|SUPER ?MINI|PRO ?MICRO|USB/.test(text);
      // which short edge has pin 1 (USB end on XIAO-type boards)
      const endLow = long ? pin1.x < (x0 + x1) / 2 : pin1.y < (y0 + y1) / 2;
      const L = long ? x1 - x0 : y1 - y0, Wd = long ? y1 - y0 : x1 - x0, sh = Math.max(1.2, Math.min(2.4, (pkgH || 3.3) - th));
      // shield over the far part of the board (antenna end left free on bare modules)
      const s0 = usb ? 0.32 : 0.05, s1 = usb ? 0.92 : 0.72, inset = Wd * 0.12;
      const a = endLow ? s0 : 1 - s1, b = endLow ? s1 : 1 - s0;
      if (long) box(x0 + L * a, y0 + inset, x0 + L * b, y1 - inset, th, th + sh, 0xc4c8cc, 'metal');
      else box(x0 + inset, y0 + L * a, x1 - inset, y0 + L * b, th, th + sh, 0xc4c8cc, 'metal');
      if (usb) {   // USB-C plug opening flush with the board end, a little proud of it
        const uw = Math.min(9, Wd * 0.5), ud = 7.4, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
        if (long) { const e = endLow ? x0 - 0.6 : x1 + 0.6, f = endLow ? e + ud : e - ud; box(Math.min(e, f), cy - uw / 2, Math.max(e, f), cy + uw / 2, th, th + 3.2, 0xd2d5d8, 'metal'); box(endLow ? e - 0.01 : e - 0.3, cy - uw / 2 + 0.5, endLow ? e + 0.3 : e + 0.01, cy + uw / 2 - 0.5, th + 0.6, th + 2.6, 0x101010); }
        else { const e = endLow ? y0 - 0.6 : y1 + 0.6, f = endLow ? e + ud : e - ud; box(cx - uw / 2, Math.min(e, f), cx + uw / 2, Math.max(e, f), th, th + 3.2, 0xd2d5d8, 'metal'); box(cx - uw / 2 + 0.5, endLow ? e - 0.01 : e - 0.3, cx + uw / 2 - 0.5, endLow ? e + 0.3 : e + 0.01, th + 0.6, th + 2.6, 0x101010); }
      }
      for (const p of smd) box(p.x - p.w * 0.35, p.y - p.h * 0.35, p.x + p.w * 0.35, p.y + p.h * 0.35, 0, th + 0.02, GOLD, 'gold');   // castellations
      return g;
    }
    // ----- electrolytic capacitor -----
    if (/CAPACITOR_POLARIZED|ELECTROLYTIC|CP_RADIAL|CP_ELEC/.test(text) || c.type === 'capacitor_polarized') {
      const r = Math.max(1.5, Math.min(ob[2] - ob[0], ob[3] - ob[1]) / 2 * 0.95), cx = (ob[0] + ob[2]) / 2, cy = (ob[1] + ob[3]) / 2, h = H || 5;
      cyl(cx, cy, r, 0.3, h, 0x1c2f73, 'gloss', 32); cyl(cx, cy, r * 0.97, h, h + 0.05, 0xcfd4da, 'metal', 32);
      if (!tht.length) box(cx - r - 0.2, cy - r - 0.2, cx + r + 0.2, cy + r + 0.2, 0, 0.3, 0x222222);
      return g;
    }
    // ----- through-hole LED -----
    if (c.type === 'led' && tht.length) {
      const col = /RED/.test(text) ? 0xff3030 : /BLUE/.test(text) ? 0x3060ff : /YELLOW/.test(text) ? 0xffd000 : /WHITE/.test(text) ? 0xf0f0ff : 0x30e060, h = H || 8.6;
      const cx = (tht[0].x + tht[tht.length - 1].x) / 2, cy = (tht[0].y + tht[tht.length - 1].y) / 2;
      cyl(cx, cy, 2.5, 0, h - 2.5, col, 'glass'); const d = new T.Mesh(new T.SphereGeometry(2.5, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), mat(col, 'glass')); d.rotation.x = Math.PI / 2; d.position.set(cx, -cy, h - 2.5); g.add(d);
      return g;
    }
    // ----- USB / USB-C receptacle: metal shell, opening away from the signal pins -----
    if (/TYPE-?C|USB|MICRO-?B/.test(text)) {
      const [x0, y0, x1, y1] = ob, h = Math.min(H || 3.2, 3.4), sig = smd.filter(p => p.w < 0.8 || p.h < 0.8);
      const sy = sig.length ? sig.reduce((a, p) => a + p.y, 0) / sig.length : y0, openLow = sy > (y0 + y1) / 2;   // pins at the back
      const bx0 = x0 + 0.2, bx1 = x1 - 0.2, by0 = openLow ? y0 - 0.4 : y0 + (y1 - y0) * 0.25, by1 = openLow ? y1 - (y1 - y0) * 0.25 : y1 + 0.4;
      box(bx0, by0, bx1, by1, 0.05, h, 0xd2d5d8, 'metal');
      const fy = openLow ? by0 : by1; box(bx0 + 0.5, fy - 0.02, bx1 - 0.5, fy + 0.02, 0.6, h - 0.6, 0x0d0d0d);
      for (const p of sig) box(p.x - p.w * 0.3, p.y - p.h * 0.4, p.x + p.w * 0.3, p.y + p.h * 0.4, 0, 0.1, TIN, 'metal');
      return g;
    }
    // ----- pin headers and through-hole connectors: black housing per row, gold pins through it -----
    if (tht.length >= 2 && (/PINHEADER|HEADER|PIN_?HEADER|CONN|JST|TERMINAL|THT_P2\.54/.test(text) || c.type === 'connector')) {
      const [x0, y0, x1, y1] = ext(tht), hh = 2.5, top = Math.max(hh + 2, H || 8.6);
      box(x0 - 0.3, y0 - 0.3, x1 + 0.3, y1 + 0.3, 0, hh, 0x161616);
      for (const p of tht) box(p.x - 0.32, p.y - 0.32, p.x + 0.32, p.y + 0.32, -3, top, GOLD, 'gold');
      return g;
    }
    // ----- SMD connectors (JST SH / GH, FPC …): beige housing over the part -----
    if (c.type === 'connector' || /JST|FPC|FFC|CONN|SOCKET|RECEPTACLE/.test(text)) {
      const [x0, y0, x1, y1] = ob; box(x0 + 0.1, y0 + 0.1, x1 - 0.1, y1 - 0.1, 0, H || 2.5, /FPC|FFC/.test(text) ? 0x2a2a2a : 0xe8dfc8);
      for (const p of smd) box(p.x - p.w * 0.35, p.y - p.h * 0.35, p.x + p.w * 0.35, p.y + p.h * 0.35, 0, 0.12, TIN, 'metal');
      return g;
    }
    // ----- tactile switch -----
    if (c.type === 'switch' || /SW_|TACT|BUTTON/.test(text)) {
      const [x0, y0, x1, y1] = ob, s = Math.min(x1 - x0, y1 - y0) * 0.8, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, h = H || 3.5;
      box(cx - s / 2, cy - s / 2, cx + s / 2, cy + s / 2, 0, Math.min(h, 1.6) * 0.75, 0x2a2a2a); box(cx - s / 2, cy - s / 2, cx + s / 2, cy + s / 2, Math.min(h, 1.6) * 0.75, Math.min(h, 1.6), 0xc4c8cc, 'metal');
      cyl(cx, cy, s * 0.22, Math.min(h, 1.6), h, 0x111111); return g;
    }
    // ----- TO-220 -----
    if (/TO-?220/.test(text)) { const [x0, , x1] = ext(tht); box(x0 - 3, -2.4, x1 + 3, 2.1, 6, H || 15, BLACK); box(x0 - 3, 0.8, x1 + 3, 2.1, 6, (H || 15) + 3, 0xc4c8cc, 'metal'); for (const p of tht) box(p.x - 0.4, p.y - 0.25, p.x + 0.4, p.y + 0.25, -3, 6, TIN, 'metal'); return g; }

    // ----- two-pad SMD parts: chip R / C / L / ferrite / fuse, diodes, LEDs, crystals -----
    if (smd.length === 2 && !tht.length) {
      const [a, b] = smd, hor = Math.abs(a.x - b.x) >= Math.abs(a.y - b.y), D = hor ? Math.abs(a.x - b.x) : Math.abs(a.y - b.y);
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2, cross = Math.min(hor ? a.h : a.w, hor ? b.h : b.w);
      const isDiode = /diode|zener|schottky/.test(c.type) || /SOD|SMA\b|SMB\b|SMC\b|DO-?214|DIODE/.test(text);
      const L = isDiode ? D + Math.min(hor ? a.w : a.h, 1.2) * 0.4 : D * 1.03, W = Math.min(cross * 0.92, L * (isDiode ? 0.7 : 0.62));
      const rect = (l0, l1, w0, w1, z0, z1, col, kind) => hor ? box(cx + l0, cy + w0, cx + l1, cy + w1, z0, z1, col, kind) : box(cx + w0, cy + l0, cx + w1, cy + l1, z0, z1, col, kind);
      const along = p => hor ? p.x - cx : p.y - cy;
      if (isDiode) {   // black body, leads under the ends, cathode band at pin 1 (K)
        const h = Math.min(pkgH || H || 1.1, W * 1.1), k = smd.find(p => /^(1|K|C|-)$/i.test(p.num)) || a, s = Math.sign(along(k)) || -1, bl = L * 0.72;
        rect(-bl / 2, bl / 2, -W / 2, W / 2, 0.08, h, BLACK);
        rect(s > 0 ? bl / 2 - bl * 0.22 : -bl / 2 + bl * 0.08, s > 0 ? bl / 2 - bl * 0.08 : -bl / 2 + bl * 0.22, -W / 2 - 0.005, W / 2 + 0.005, h - 0.001, h + 0.01, 0xd8d8d8);
        for (const p of smd) { const q = along(p); rect(q - 0.35 * Math.min(hor ? p.w : p.h, 1), q + 0.35 * Math.min(hor ? p.w : p.h, 1), -W * 0.3, W * 0.3, 0, 0.12, TIN, 'metal'); }
        return g;
      }
      const isLed = c.type === 'led' || /LED/.test(text), isXtal = c.type === 'crystal' || /XTAL|CRYSTAL|OSC/.test(text);
      const isCap = /capacitor/.test(c.type) || /^C\d/.test(c.ref) && !/RES/.test(text), isInd = c.type === 'inductor' || /^L\d/.test(c.ref) || /INDUCTOR|FERRITE|BEAD/.test(text), isFuse = c.type === 'fuse' || /^F\d/.test(c.ref) || /FUSE|PTC/.test(text);
      const h = isXtal ? Math.min(H || 0.8, 1.2) : Math.min(pkgH || W * (isCap ? 0.85 : isInd ? 0.75 : isLed ? 0.8 : 0.55), H > 0.1 ? H : 9);
      const e = Math.min(L * 0.22, 0.5);   // tinned end caps
      if (isXtal) { rect(-L / 2, L / 2, -W / 2, W / 2, 0, h * 0.3, 0xe0d6c0); rect(-L / 2 + 0.1, L / 2 - 0.1, -W / 2 + 0.1, W / 2 - 0.1, h * 0.3, h, 0xc4c8cc, 'metal'); return g; }
      rect(-L / 2, -L / 2 + e, -W / 2, W / 2, 0, h, TIN, 'metal'); rect(L / 2 - e, L / 2, -W / 2, W / 2, 0, h, TIN, 'metal');
      const body = isCap ? 0xa4825a : isInd ? 0x3c3c3c : isFuse ? 0xe6e0d0 : isLed ? 0xf2f2f2 : 0xece8e0;
      rect(-L / 2 + e, L / 2 - e, -W / 2, W / 2, 0, h, body);
      if (!isCap && !isInd && !isFuse && !isLed) rect(-L / 2 + e, L / 2 - e, -W / 2 + 0.01, W / 2 - 0.01, h, h + 0.02, 0x161616);   // resistor: black top
      if (isLed) { const col = /RED/.test(text) ? 0xff3a3a : /BLUE/.test(text) ? 0x3a6cff : /YELLOW|AMBER|ORANGE/.test(text) ? 0xffc400 : /WHITE/.test(text) ? 0xfafaff : 0x3ae070; rect(-L / 2 + e + 0.05, L / 2 - e - 0.05, -W / 2 + 0.05, W / 2 - 0.05, h, h + 0.08, col, 'glass'); }
      return g;
    }

    // ----- ICs: leads in rows (SOT / SOIC / MSOP / TSSOP / QFP: gull-wing) or no leads (QFN / DFN / SON / LGA) -----
    if (smd.length >= 3 && !tht.length) {
      const [px0, py0, px1, py1] = ext(smd), mx = (px0 + px1) / 2, my = (py0 + py1) / 2;
      const noLead = /QFN|DFN|SON|LGA|BGA|WLCSP|CSP|\bUSON|\bVSON|\bWSON|TDFN|UDFN|LLP/.test(text);
      // which side each pad is on (edge pads: on the outline; a big pad in the middle is the exposed pad)
      const tol = 0.25, side = p => Math.abs(p.x + p.w / 2 - px1) < tol && p.w >= p.h * 0.9 ? 'R' : Math.abs(p.x - p.w / 2 - px0) < tol && p.w >= p.h * 0.9 ? 'L' : Math.abs(p.y + p.h / 2 - py1) < tol && p.h >= p.w * 0.9 ? 'B' : Math.abs(p.y - p.h / 2 - py0) < tol && p.h >= p.w * 0.9 ? 'T' : null;
      const rows = { L: [], R: [], T: [], B: [] }; for (const p of smd) { const s = side(p); if (s) rows[s].push(p); }
      const lr = rows.L.length + rows.R.length, tb = rows.T.length + rows.B.length;
      if (noLead || lr + tb < 3) {   // flat package over its pads
        const h = Math.min(pkgH || 0.85, 1.6), [x0, y0, x1, y1] = noLead ? [px0, py0, px1, py1] : ob;
        box(x0, y0, x1, y1, 0.02, h, BLACK);
        for (const p of smd) box(p.x - p.w / 2 - 0.01, p.y - p.h / 2 - 0.01, p.x + p.w / 2 + 0.01, p.y + p.h / 2 + 0.01, 0, 0.05, TIN, 'metal');
        dot(x0 + Math.min(0.5, (x1 - x0) * 0.2), y0 + Math.min(0.5, (y1 - y0) * 0.2), h);
        return g;
      }
      // body between the lead rows (to the pads' inner edges, a little over them)
      const inner = (arr, k, sgn) => arr.length ? Math.min(...arr.map(p => sgn * (p[k] - (k === 'x' ? mx : my)) - (k === 'x' ? p.w : p.h) / 2)) + 0.12 : null;
      const hx = lr ? Math.min(inner(rows.L, 'x', -1) ?? Infinity, inner(rows.R, 'x', 1) ?? Infinity) : (px1 - px0) / 2 + 0.1;
      const hy = tb ? Math.min(inner(rows.T, 'y', -1) ?? Infinity, inner(rows.B, 'y', 1) ?? Infinity) : (py1 - py0) / 2 + 0.1;
      const hxB = lr ? hx : Math.max(hx, (px1 - px0) / 2 + 0.15), hyB = tb ? hy : Math.max(hy, (py1 - py0) / 2 + 0.15);
      const h = Math.min(pkgH || (smd.length <= 6 ? 1.1 : 1.5), Math.max(H || 1.2, 0.8), 3), z0 = 0.1;
      box(mx - hxB, my - hyB, mx + hxB, my + hyB, z0, h, BLACK);
      // gull-wing leads: from the body side at mid-height down to a foot on the pad
      const lt = 0.13, lz = z0 + (h - z0) * 0.4;
      for (const [s, arr] of Object.entries(rows)) for (const p of arr) {
        const horiz = s === 'L' || s === 'R', sg = s === 'R' || s === 'B' ? 1 : -1, cr = horiz ? p.h : p.w, lw = cr > 1.5 ? cr * 0.9 : Math.min(cr, 0.5) * 0.85;   // a wide pad is a tab (SOT-223, DPAK)
        const edge = horiz ? mx + sg * hxB : my + sg * hyB, outer = horiz ? p.x + sg * p.w * 0.38 : p.y + sg * p.h * 0.38, knee = edge + sg * Math.max(0.15, Math.abs(outer - edge) * 0.35);
        const c0 = horiz ? p.y : p.x;
        const seg = (a0, a1, z0_, z1_) => horiz ? box(Math.min(a0, a1), c0 - lw / 2, Math.max(a0, a1), c0 + lw / 2, z0_, z1_, TIN, 'metal') : box(c0 - lw / 2, Math.min(a0, a1), c0 + lw / 2, Math.max(a0, a1), z0_, z1_, TIN, 'metal');
        seg(edge, knee, lz - lt / 2, lz + lt / 2); seg(knee - sg * lt / 2, knee + sg * lt / 2, 0, lz + lt / 2); seg(knee, outer, 0, lt);
      }
      // pin 1 mark
      const p1 = pin1, ox = Math.sign(p1.x - mx) || -1, oy = Math.sign(p1.y - my) || -1;
      if (hxB > 0.5 && hyB > 0.5) dot(mx + ox * (hxB - 0.35), my + oy * (hyB - 0.35), h);
      return g;
    }
    // ----- anything else: a dark body over its outline -----
    const [x0, y0, x1, y1] = ob, h = H || 1.5;
    box(x0 + (x1 - x0) * 0.06, y0 + (y1 - y0) * 0.06, x1 - (x1 - x0) * 0.06, y1 - (y1 - y0) * 0.06, tht.length ? 0.4 : 0.05, h, BLACK);
    for (const p of tht) box(p.x - Math.min(0.32, p.drill * 0.4), p.y - Math.min(0.32, p.drill * 0.4), p.x + Math.min(0.32, p.drill * 0.4), p.y + Math.min(0.32, p.drill * 0.4), -2.5, 0.5, TIN, 'metal');
    if (x1 - x0 > 2 && y1 - y0 > 2) dot(x0 + 0.6, y0 + 0.6, h);
    return g;
  }

  // ---------- real models (EasyEDA library OBJ) ----------
  // OBJ with inline materials (newmtl … Kd … d … endmtl; d is transparency). One template per model uuid,
  // centred in x / y with its bottom at z = 0; instances share geometry and materials.
  const objCache = new Map();
  async function fetchObj(uuid) {
    const url = 'https://modules.easyeda.com/3dmodel/' + uuid;
    let store = null; try { store = await caches.open('circuitpilot-3d'); const hit = await store.match(url); if (hit) return hit.text(); } catch (e) { store = null; }
    const r = await fetch(url); if (!r.ok) throw new Error('3D model ' + r.status);
    const text = await r.text(); try { if (store) await store.put(url, new Response(text)); } catch (e) { }
    return text;
  }
  function parseObj(text, T) {
    const V = [], mats = {}, groups = []; let mat = null, cur = null, def = null;
    for (const line of text.split('\n')) {
      const t = line.trim().split(/\s+/), k = t[0];
      if (k === 'v') V.push(+t[1], +t[2], +t[3]);
      else if (k === 'newmtl') { def = mats[t[1]] = { kd: [0.6, 0.6, 0.6], d: 0 }; }
      else if (k === 'Kd' && def) def.kd = [+t[1], +t[2], +t[3]];
      else if (k === 'd' && def) def.d = +t[1] || 0;
      else if (k === 'endmtl') def = null;
      else if (k === 'usemtl') { mat = t[1]; cur = null; }
      else if (k === 'f') {
        if (!cur) { cur = { mat, idx: [] }; groups.push(cur); }
        const f = t.slice(1).map(s => { const i = parseInt(s, 10); return i < 0 ? V.length / 3 + i : i - 1; });
        for (let i = 1; i + 1 < f.length; i++) cur.idx.push(f[0], f[i], f[i + 1]);
      }
    }
    if (!V.length) throw new Error('empty 3D model');
    let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < V.length; i += 3) for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], V[i + a]); mx[a] = Math.max(mx[a], V[i + a]); }
    const off = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, mn[2]];
    const pos = new Float32Array(V.length); for (let i = 0; i < V.length; i++) pos[i] = V[i] - off[i % 3];
    const g = new T.Group(), byMat = new Map();
    for (const gr of groups) { const k = gr.mat || ''; if (!byMat.has(k)) byMat.set(k, []); byMat.get(k).push(...gr.idx); }
    for (const [k, idx] of byMat) {
      const geo = new T.BufferGeometry(); geo.setAttribute('position', new T.BufferAttribute(pos, 3)); geo.setIndex(idx);
      const nonIdx = geo.toNonIndexed(); nonIdx.computeVertexNormals();
      const m = mats[k] || { kd: [0.6, 0.6, 0.6], d: 0 }, op = Math.max(0.15, 1 - m.d), bright = (m.kd[0] + m.kd[1] + m.kd[2]) / 3;
      g.add(new T.Mesh(nonIdx, new T.MeshStandardMaterial({ color: new T.Color(m.kd[0], m.kd[1], m.kd[2]), roughness: 0.55, metalness: bright > 0.6 ? 0.25 : 0.05, transparent: op < 1, opacity: op, side: T.DoubleSide })));
    }
    g.userData.size = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
    return g;
  }
  function objTemplate(uuid, T) {
    if (!objCache.has(uuid)) objCache.set(uuid, fetchObj(uuid).then(t => parseObj(t, T)).catch(e => { objCache.delete(uuid); throw e; }));
    return objCache.get(uuid);
  }
  // the footprint's model info; parts placed before 3D models were kept get it once from the parts database
  const infoAsked = new Map();   // part code -> pending request, so parts sharing a footprint wait for the same answer
  async function modelInfo(c) {
    // database / custom parts: their library entry; palette parts (resistor, LED…): the JLCPCB part behind their footprint
    const key = c.type === 'part' ? c.lcsc : c.dbfp; if (!key) return null;
    const lib = Model.S.lib[key], fp = lib && lib.footprint; if (!fp) return null;
    if ('model3d' in fp) return fp.model3d;
    const code = /^(C\d+|EE-[0-9A-F]{32})$/.test(key) ? key : (c.type === 'part' ? Model.lcscOf(c) : '');
    if (!code) return null;
    if (!infoAsked.has(code)) infoAsked.set(code, Engine.partsApi('get/' + encodeURIComponent(code)).catch(() => null));
    const m = await infoAsked.get(code);
    if ('model3d' in fp) return fp.model3d;
    const m3 = m && m.footprint ? m.footprint.model3d || null : null;
    // only when the footprint is the library's own (same pads): an edited footprint keeps the simple shape
    const same = m && m.footprint && m.footprint.pads.length === fp.pads.length && m.footprint.pads.every((p, i) => Math.abs(p.x - fp.pads[i].x) < 0.01 && Math.abs(p.y - fp.pads[i].y) < 0.01);
    fp.model3d = same ? m3 : null;
    return fp.model3d;
  }
  // model in footprint coordinates (CircuitPilot footprint centre, 3D y up): EasyEDA rotations are in the y-down
  // footprint frame, so x / z angles change sign; a quarter turn is added when the model does not fit its outline
  async function realModel(c, T) {
    const m3 = await modelInfo(c); if (!m3 || !m3.uuid) return null;
    const tpl = await objTemplate(m3.uuid, T), inst = tpl.clone(), d = Math.PI / 180;
    let rz = -(m3.rz || 0);
    if (m3.w && m3.h) {
      const [sx, sy] = tpl.userData.size, a = Math.abs(Math.round(rz / 90)) % 2, fx = a ? sy : sx, fy = a ? sx : sy;
      const fits = (p, q) => Math.abs(p - m3.w) <= 0.15 * m3.w + 0.2 && Math.abs(q - m3.h) <= 0.15 * m3.h + 0.2;
      if (!fits(fx, fy) && fits(fy, fx) && !(m3.rx || m3.ry)) rz += 90;
    }
    inst.rotation.set(-(m3.rx || 0) * d, (m3.ry || 0) * d, rz * d);
    inst.position.set(m3.x || 0, -(m3.y || 0), m3.z || 0);
    const g = new T.Group(); g.add(inst); g.userData.real = true;
    return g;
  }
  // part on the board: footprint frame → board (CircuitPilot rotates clockwise in y-down = negative angle in 3D;
  // a bottom part is flipped over: x and z mirrored, i.e. turned 180° about y)
  function placeOnBoard(g, c, th) {
    const wrapG = new (window.THREE.Group)(); wrapG.add(g);
    if (Pcb.isBottom(c)) g.scale.set(-1, 1, -1);
    wrapG.rotation.z = -(c.pcb.rot || 0) * Math.PI / 180;
    wrapG.position.set(c.pcb.x, -c.pcb.y, Pcb.isBottom(c) ? 0 : th);
    return wrapG;
  }

  // ---------- build ----------
  async function rebuild(fit) {
    if (busy) { dirty = true; return; }
    const S = Model.S, T = window.THREE; if (!T || !renderer) return;
    dirty = false;
    if (root) scene.remove(root);
    if (!S.board.w || !Pcb.placed().length) { $('#p3msg').textContent = 'No PCB yet — click “Generate PCB”'; $('#p3msg').style.display = 'block'; draw(); return; }
    $('#p3msg').style.display = 'none';
    busy = true;
    const [top, bot] = await Promise.all([texture('F'), texture('B')]);
    busy = false;
    root = new T.Group(); scene.add(root);
    const th = Pcb.boardThickness ? Pcb.boardThickness() : 1.6, poly = Pcb.boardPoly();   // flex boards are thin
    const shape = new T.Shape(poly.map(q => new T.Vector2(q[0], -q[1])));
    for (const hh of S.pcb.holes || []) { const p = new T.Path(); p.absarc(hh.x, -hh.y, hh.d / 2, 0, Math.PI * 2, true); shape.holes.push(p); }
    const fit2 = t => { if (!t) return; t.repeat.set(1 / S.board.w, 1 / S.board.h); t.offset.set(0, 1); };
    fit2(top); fit2(bot);
    // board edge (FR4) + textured top and bottom faces
    const side = new T.Mesh(new T.ExtrudeGeometry(shape, { depth: th, bevelEnabled: false }), [new T.MeshBasicMaterial({ visible: false }), new T.MeshStandardMaterial({ color: 0xc9b98a, roughness: 0.8 })]);
    root.add(side);
    const faceT = new T.Mesh(new T.ShapeGeometry(shape), new T.MeshStandardMaterial({ map: top, roughness: 0.55, metalness: 0.05 })); faceT.position.z = th + 0.001; root.add(faceT);
    const faceB = new T.Mesh(new T.ShapeGeometry(shape), new T.MeshStandardMaterial({ map: bot, roughness: 0.55, metalness: 0.05, side: T.BackSide })); faceB.position.z = -0.001; root.add(faceB);
    const parts = new T.Group(); parts.visible = ui.parts; root.add(parts); root.userData.parts = parts;
    const myRoot = root, cs = Pcb.placed(), simple = new Map();
    for (const c of cs) {
      let m; try { m = placeOnBoard(partModel(c, T), c, th); } catch (e) { console.warn('3D model', c.ref, e); continue; }
      parts.add(m); simple.set(c.ref, m);
    }
    resize(); if (fit) preset('iso'); else draw();
    const info = n => `<b>${S.board.w} × ${S.board.h} × ${th} mm</b> · ${cs.length} parts · ${S.pcb.traces.length} tracks · ${S.pcb.vias.length} vias` +
      (n ? `<br><span class="muted">${n} real 3D models: JLCEDA/EasyEDA Official Library (<a href="https://easyeda.com" target="_blank" rel="noopener">easyeda.com</a>, <a href="https://lceda.cn" target="_blank" rel="noopener">lceda.cn</a>)</span>` : '') +
      `<br><span class="muted">Drag to orbit · right-drag / Shift-drag to pan · wheel to zoom</span>`;
    $('#p3info').innerHTML = info(0);
    // real models replace the simple shapes as they arrive (each model is downloaded once, then cached)
    if (ui.real) {
      let n = 0;
      await Promise.all(cs.map(async c => {
        let g = null; try { g = await realModel(c, T); } catch (e) { g = null; }
        if (!g || root !== myRoot) return;
        parts.remove(simple.get(c.ref)); parts.add(placeOnBoard(g, c, th)); n++;
        draw();
      }));
      if (root === myRoot) { $('#p3info').innerHTML = info(n); draw(); }
    }
  }
  // PNG of the 3D board for documents (rendered off-screen at a fixed size on a light background)
  async function snapshot(view = 'iso', w = 1400, h = 950, bg = '#ffffff') {
    await loadThree(); const T = window.THREE;
    if (!renderer) setup();
    if (dirty || !root) { dirty = true; await rebuild(false); }
    if (!root) return null;
    const old = Object.assign({}, cam), size = renderer.getSize(new T.Vector2()), pr = renderer.getPixelRatio(), oc = renderer.getClearColor(new T.Color()).getHex(), oa = renderer.getClearAlpha();
    const partsVis = root.userData.parts ? root.userData.parts.visible : true;
    if (root.userData.parts) root.userData.parts.visible = true;
    renderer.setPixelRatio(1); renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setClearColor(bg, 1);
    const S = Model.S;
    if (view === 'top') { cam.th = -Math.PI / 2; cam.ph = 0.0001; } else if (view === 'bottom') { cam.th = -Math.PI / 2; cam.ph = Math.PI - 0.0001; } else { cam.th = -1.15; cam.ph = 0.95; }
    cam.tx = S.board.w / 2; cam.ty = -S.board.h / 2; cam.tz = 0;
    const fov = camera.fov * Math.PI / 180, span = Math.max(S.board.w / camera.aspect, S.board.h) * (view === 'iso' ? 1.25 : 1.1);
    cam.r = span / 2 / Math.tan(fov / 2) + 2;
    draw();
    const url = renderer.domElement.toDataURL('image/png');
    Object.assign(cam, old); if (root.userData.parts) root.userData.parts.visible = partsVis;
    renderer.setPixelRatio(pr); renderer.setSize(size.x, size.y); renderer.setClearColor(oc, oa); resize(); draw();
    return { url, w, h };
  }
  return { init, setOn, ui, rebuild: () => rebuild(true), snapshot };
})();
