'use strict';
// First visit: a welcome with a live 3D demo (the chest ECG node enclosure turning and coming apart, board inside), what's new
// in each version, a guided tour of the app (skippable), and a feedback form that reaches the developer.
const Welcome = (() => {
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = { get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { } } };

  // ---------- what changed, newest first ----------
  const CHANGELOG = [
    { v: '2026.11.23', date: '2026-11-23', items: [
      'Board code + revision printed on every PCB (e.g. CP-K7Q2M R2): search it in Projects to find the schematic a board was made from',
      'Welcome tour, this What\'s new list and 💬 Feedback straight to the developer',
      'Enclosure: Closed ↔ Apart slider (lid lifts, then the board comes out) and Spin (on by default)',
      'Export → All projects (.zip of .json) backs up every design at once; Projects → Import takes that zip back (you tick which ones)'] },
    { v: '2026.11.19', date: '2026-11-19', items: [
      'Import KiCad projects (KiCad 6–9): parts with real footprints, nets, tracks, zones, up to 4 copper layers',
      '4-layer boards: inner GND / power planes or signal layers, JLCPCB 4-layer rules',
      'EasyEDA Pro: design-rules file in the export (JLCPCB minimums), only the open PCB with its sheets'] },
    { v: '2026.11.18', date: '2026-11-18', items: [
      'Free line tool (D) on any layer: copper, silkscreen, mask',
      'Projects list sorted by name, created or last modified; no repeated designs after syncs',
      'GitHub and Google Drive keep a project list (name, created, modified): Sync uploads / downloads only what changed'] },
    { v: '2026.11.17', date: '2026-11-17', items: [
      'Several PCBs in one project, like schematic sheets: each sheet chooses its PCB',
      'Enclosures for boards joined by break-off tabs: each board placed on its own; hardware library (screws, inserts) and assembly-step drawings'] },
    { v: '2026.11.16', date: '2026-11-16', items: [
      'Free CircuitPilot AI: sign in with GitHub, no API key needed (daily limit per person)',
      'Firmware pin header (design_pins.h) made from the schematic'] },
    { v: '2026.11.14', date: '2026-11-14', items: ['Save designs to your own GitHub repository (one folder per design, EasyEDA import zip included)', 'Windows app and install guide'] },
    { v: '2026.10.30', date: '2026-10-30', items: ['Tutorial and user guide (📖 Guide)', 'Desktop CNC milling (CNC 3018 / GRBL): isolation G-code, drill files, milled-board 3D'] },
    { v: '2026.10.28', date: '2026-10-28', items: ['Sign in with Google: projects and My Library in your Google Drive, on any PC', 'Enclosures ready for JLC3DP / JLCCNC, gold PCB electrodes'] },
    { v: '2026.10.27', date: '2026-10-27', items: ['Upload to JLCPCB with a live price, like EasyEDA', 'Net names on tracks and pads; enclosure dimensions and 📏 measure'] },
    { v: '2026.10.24', date: '2026-10-24', items: ['EasyEDA export that opens clean in EasyEDA (pours, footprints, rules)', 'JLCPCB clearance and hole rules, AI-placed tracks and vias'] },
    { v: '2026.10.22', date: '2026-10-22', items: ['1.6 million LCSC / JLCPCB parts plus KiCad, SparkFun and Digi-Key libraries in one search', 'Claude Desktop (MCP) in one command'] },
    { v: '2026.10.12', date: '2026-10-12', items: ['Any AI provider: your own URL and key (Gemini, Claude, OpenAI, Ollama, OpenRouter …)'] },
    { v: '2026.10.10', date: '2026-10-10', items: ['Web version at pcbgo.site', 'One-click order at JLCPCB and JLC3DP', '35 enclosure templates (wrist, chest, body-worn, boxes)', 'Autorouter with rip-up and reroute'] },
    { v: '2026.10.09', date: '2026-10-09', items: ['First release: AI copilot for schematic and PCB, component database, PCB editor with copper pours, 3D view, light and dark themes'] },
  ];
  const VERSION = CHANGELOG[0].v;

  // ---------- the welcome dialog ----------
  let el = null, afterClose = [], demo = null;
  function build() {
    el = document.createElement('div'); el.id = 'welModal'; el.className = 'modal hidden';
    el.innerHTML = `<div class="dlg wel-dlg">
      <div class="wel-3d"><div class="wel-stage" id="welStage"><div class="wel-load muted small">Loading the 3D model…</div></div>
        <div class="wel-ctl"><small>Closed</small><input type="range" id="welT" min="0" max="100" value="0" title="Drag to take the ECG node apart"><small>Apart</small></div>
        <div class="wel-cap muted small">A chest ECG node made in CircuitPilot (XIAO nRF52840, ECG front end, gold skin electrodes): schematic → PCB → enclosure, all in one project. Drag to turn it.</div></div>
      <div class="wel-side">
        <div class="row-h"><h2 id="welTitle">Welcome to CircuitPilot</h2><button id="welClose" title="Close">✕</button></div>
        <p class="small" style="margin:4px 0 8px">Describe a circuit and the AI copilot picks real parts, draws the schematic, lays out and routes the PCB, designs the enclosure and orders it from JLCPCB — you can edit everything by hand.</p>
        <div class="seg wel-tabs"><button data-t="start" class="on">Get started</button><button data-t="new">What's new <span class="badge basic">v${VERSION}</span></button></div>
        <div id="welBody" class="wel-body"></div>
        <div class="row wel-act"><button id="welTour" class="primary">▶ Take the tour (1 min)</button><button id="welSkip">Skip</button><button id="welFb" title="Ideas, bugs, questions">💬 Feedback</button><a class="wel-gh" href="https://github.com/Abdelhayali/CircuitPilot" target="_blank" rel="noopener" title="Source code, releases, Windows app and issues on GitHub"><svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg> GitHub</a></div>
      </div></div>`;
    document.body.appendChild(el);
    el.querySelector('.wel-tabs').onclick = e => { const b = e.target.closest('button[data-t]'); if (b) tab(b.dataset.t); };
    $('#welClose').onclick = $('#welSkip').onclick = () => close();
    $('#welTour').onclick = () => { close(true); tour(); };
    $('#welFb').onclick = () => { feedback(); };
    $('#welT').oninput = e => { if (demo) { demo.manual = performance.now(); demo.t = +e.target.value / 100; } };
  }
  function tab(t) {
    el.querySelectorAll('.wel-tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
    const seen = store.get('cp.seenVersion');
    $('#welBody').innerHTML = t === 'new'
      ? CHANGELOG.map((c, i) => `<div class="wel-ver${i === 0 ? ' cur' : ''}"><b>v${esc(c.v)}</b> <span class="muted small">${esc(c.date)}</span>${i === 0 ? ' <span class="badge basic">latest</span>' : seen && c.v > seen ? ' <span class="badge basic">new for you</span>' : ''}<ul>${c.items.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>`).join('')
      : `<ol class="wel-steps">
          <li><b>Connect an AI</b> — CircuitPilot's free AI (sign in with GitHub, no key) or your own key: Gemini, Claude, OpenAI, Ollama …</li>
          <li><b>New project</b>, then tell the copilot what to build, e.g. <i>“ESP32-C3 with USB-C, LiPo charger and a status LED”</i></li>
          <li><b>PCB</b>: Generate PCB places and routes the board; check it with DRC (JLCPCB rules built in)</li>
          <li><b>Enclosure</b>: a 3D case around the board, from a template or the AI</li>
          <li><b>Order</b> the board at JLCPCB and the case at JLC3DP — or export Gerbers, EasyEDA, KiCad-style files</li>
          <li><b>Save</b>: projects stay in this browser; save them to your GitHub (⌥ GitHub) to have them on every PC</li></ol>
         <p class="muted small">You can open this again any time with 🎬 What's new, and the full guide with 📖 Guide.</p>`;
  }
  function open(t = 'start', title) {
    if (!el) build();
    $('#welTitle').textContent = title || (t === 'new' ? 'What\'s new in CircuitPilot' : 'Welcome to CircuitPilot');
    tab(t); el.classList.remove('hidden'); startDemo();
  }
  function close(toTour) {
    if (!el || el.classList.contains('hidden')) return;
    el.classList.add('hidden'); stopDemo();
    store.set('cp.welcome', '1'); store.set('cp.seenVersion', VERSION);
    if (!toTour) runAfter();
  }
  const runAfter = () => { const f = afterClose; afterClose = []; for (const fn of f) try { fn(); } catch (e) { } };
  const busy = () => !!(el && !el.classList.contains('hidden')) || !!tourEl;
  // the web version (pcbgo.site) opens the welcome on every visit; the desktop app on the first visit. A newer version than
  // this browser has seen opens on What's new. Then `after` (the AI chooser)
  const web = () => document.body.classList.contains('static-web') || /(^|\.)pcbgo\.site$/i.test(location.hostname);
  function start(after) {
    if (after) afterClose.push(after);
    if (busy()) return;
    const fresh = store.get('cp.seenVersion') !== VERSION;
    if (web()) open(fresh && store.get('cp.welcome') ? 'new' : 'start');
    else if (!store.get('cp.welcome')) open('start');
    else if (store.get('cp.seenVersion') !== VERSION) open('new');
    else runAfter();
  }

  // ---------- 3D demo: the chest ECG node turning, coming apart and closing again ----------
  async function startDemo() {
    if (demo) { demo.run = true; demo.loop(); return; }
    const stage = $('#welStage');
    try {
      const T = await loadThree(), data = await (await fetch('data/demo-ecg.json?v=' + VERSION)).json();
      if (!el || el.classList.contains('hidden')) return;
      stage.innerHTML = '';
      const r = new T.WebGLRenderer({ antialias: true, alpha: true }); r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1)); stage.appendChild(r.domElement);
      const scene = new T.Scene(), cam = new T.PerspectiveCamera(30, 1, 1, 2000); cam.up.set(0, 0, 1);
      scene.add(new T.HemisphereLight(0xffffff, 0x334455, 0.8));
      const d1 = new T.DirectionalLight(0xffffff, 0.8); d1.position.set(80, -120, 200); scene.add(d1);
      const d2 = new T.DirectionalLight(0xffffff, 0.35); d2.position.set(-150, 100, 80); scene.add(d2);
      const root = new T.Group(); scene.add(root);
      const lids = [], boards = [], all = [];
      for (const p of data.parts) {
        const raw = Uint8Array.from(atob(p.pos), c => c.charCodeAt(0)), q = new Int16Array(raw.buffer), f = new Float32Array(q.length); for (let i = 0; i < q.length; i++) f[i] = q[i] * data.q;
        const g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(f, 3)); g.computeVertexNormals();
        let col; try { col = new T.Color(p.color || (p.kind === 'print' ? '#5b6370' : '#888')); } catch (e) { col = new T.Color('#888'); }
        const m = new T.Mesh(g, new T.MeshStandardMaterial({ color: col, roughness: p.color === 'gold' || p.color === 'silver' ? 0.35 : 0.65, metalness: p.color === 'gold' || p.color === 'silver' ? 0.6 : 0.05, side: T.DoubleSide }));
        m.userData = p; root.add(m); all.push(m);
        if (p.explode) lids.push(m); else if (/^board|battery|header/i.test(p.name) || p.kind === 'board') boards.push(m);   // rides out with the board
      }
      // the PCB: board slab with its holes and a box per part (as the Enclosure view draws it)
      const P = data.pcb, pg = new T.Group();
      const sh = new T.Shape(P.outline.map(q => new T.Vector2(q[0], q[1]))); for (const h of P.holes) { const pa = new T.Path(); pa.absarc(h[0], h[1], h[2] / 2, 0, Math.PI * 2, true); sh.holes.push(pa); }
      const slab = new T.Mesh(new T.ExtrudeGeometry(sh, { depth: P.t, bevelEnabled: false }), new T.MeshStandardMaterial({ color: 0x1f7a3a, roughness: 0.8 })); slab.position.z = P.z; pg.add(slab);
      const COL = { ic: 0x2b2b2b, connector: 0xc9c9c9, resistor: 0x2a6cc0, capacitor: 0xb08850, led: 0x37d67a, battery: 0x222222 };
      for (const [x0, y0, x1, y1, h, bot, type, plug] of P.parts) {
        const b = new T.Mesh(new T.BoxGeometry(Math.max(0.6, x1 - x0) * 0.92, Math.max(0.6, y1 - y0) * 0.92, h), new T.MeshStandardMaterial({ color: plug ? 0xd8d8d8 : COL[type] ?? 0x3a3a3a, roughness: 0.5, metalness: plug ? 0.6 : 0.1 }));
        b.position.set((x0 + x1) / 2, (y0 + y1) / 2, bot ? P.z - h / 2 : P.z + P.t + h / 2); pg.add(b);
      }
      pg.position.set(-P.origin[0], -P.origin[1], -P.origin[2]); root.add(pg); boards.push(pg);
      for (const m of boards) m.userData.z0 = m.position.z;
      // camera on the model's bounding box
      const box = new T.Box3().setFromObject(root), c = box.getCenter(new T.Vector3()), size = box.getSize(new T.Vector3()).length();
      const o = { th: -0.9, ph: 1.05, r: size * 1.55 };
      const fit = () => { const w = stage.clientWidth || 400, h = stage.clientHeight || 300; r.setSize(w, h); cam.aspect = w / h; cam.updateProjectionMatrix(); o.r = size * 2.4 / Math.min(1, cam.aspect); };
      fit(); new ResizeObserver(fit).observe(stage);
      // drag to turn
      let drag = null; r.domElement.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY }; demo.manual = performance.now(); r.domElement.setPointerCapture(e.pointerId); });
      r.domElement.addEventListener('pointermove', e => { if (!drag) return; o.th -= (e.clientX - drag.x) * 0.01; o.ph = Math.max(0.15, Math.min(Math.PI - 0.15, o.ph - (e.clientY - drag.y) * 0.01)); drag = { x: e.clientX, y: e.clientY }; demo.manual = performance.now(); });
      r.domElement.addEventListener('pointerup', () => { drag = null; });
      const ease = x => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
      let last = 0, clock = 0;
      demo = { run: true, t: 0, manual: 0, loop: null };
      demo.loop = now => {
        if (!demo.run) return;
        requestAnimationFrame(demo.loop);
        if (!now || document.hidden) { last = 0; return; }
        const dt = last ? Math.min(0.05, (now - last) / 1000) : 0; last = now;
        const idle = now - demo.manual > 6000;
        if (!drag) o.th += dt * 0.35;
        // on its own: closed 2 s → opens over 2.5 s → apart 2 s → closes over 2.5 s
        if (idle) { clock = (clock + dt) % 9; const k = clock < 2 ? 0 : clock < 4.5 ? (clock - 2) / 2.5 : clock < 6.5 ? 1 : 1 - (clock - 6.5) / 2.5; demo.t = k; const s = $('#welT'); if (s) s.value = Math.round(k * 100); }
        const tl = ease(demo.t / 0.6), tb = ease((demo.t - 0.35) / 0.65);
        for (const m of boards) m.position.z = m.userData.z0 + 10 * tb;
        for (const m of lids) { const e = m.userData.explode, up = e[2] > 0; m.position.set(e[0] * tl, e[1] * tl, e[2] * tl + (up ? 10 * tb + 4 * tl : 0)); }   // lids up over the board, skin-side parts (adhesive) down
        cam.position.set(c.x + o.r * Math.sin(o.ph) * Math.cos(o.th), c.y + o.r * Math.sin(o.ph) * Math.sin(o.th), c.z + 8 + o.r * Math.cos(o.ph));
        cam.lookAt(c.x, c.y, c.z + 9); r.render(scene, cam);
      };
      demo.loop();
    } catch (e) { stage.innerHTML = `<div class="wel-load muted small">The 3D demo needs an internet connection (${esc(e.message)})</div>`; }
  }
  function stopDemo() { if (demo) demo.run = false; }
  let three = null;
  function loadThree() {
    if (window.THREE) return Promise.resolve(window.THREE);
    return three || (three = new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js'; s.onload = () => res(window.THREE); s.onerror = () => rej(new Error('three.js did not load')); document.head.appendChild(s); }));
  }

  // ---------- guided tour: a spotlight on each part of the app, Next / Back / Skip ----------
  const STEPS = [
    { sel: '#btnNew', title: 'Start a project', text: 'Create a new design here. ▤ Projects opens your designs and imports KiCad, EasyEDA and CircuitPilot files.' },
    { sel: ['#modelSel', '#btnConnect'], title: 'Connect the AI', text: 'Choose the model the copilot uses: CircuitPilot\'s free AI (sign in with GitHub, no key) or your own key — Gemini, Claude, OpenAI, Ollama and more.' },
    { sel: '#prompt', title: 'Ask the copilot', text: 'Describe what to build, e.g. “nRF52840 wearable with a LiPo charger, IMU and ECG front end”. It picks real parts, draws the schematic and the PCB. Attach photos or datasheets with 📎.' },
    { sel: '#partSearch', title: 'Add parts yourself', text: 'Search 1.6 million LCSC / JLCPCB parts plus the KiCad, SparkFun and Digi-Key libraries, then drop them on the schematic and wire pin to pin.' },
    { sel: '.tab[data-view="sch"]', title: 'One project, four views', text: 'Schematic → PCB → Enclosure → Documentation. Every view works on the same design, so a change in one shows in the others.' },
    { sel: '#btnGen', view: 'pcb', title: 'Make the PCB', text: 'Generate PCB places and routes the board. Route, Optimize, DRC and Rules (JLCPCB presets, 2 or 4 layers) are beside it.' },
    { sel: '#btnOrderPcb', view: 'pcb', title: 'Order it', text: 'DRC check, Gerbers with the board code printed on the PCB, and a live JLCPCB price. Export ▾ has Gerbers, EasyEDA, BOM, CPL and more.' },
    { sel: '.tab[data-view="enc"]', title: 'A case around it', text: 'The Enclosure view builds a 3D-printable case around the board — templates or the AI — with an explode slider and STL / STEP files for JLC3DP.' },
    { sel: '#btnSave', view: 'sch', title: 'Saving', text: 'Projects are saved as you work (Ctrl+S to save now). They live in this browser unless you sign in.' },
    { sel: '#ghBtn', title: 'Your projects on every PC', text: 'Use ⌥ GitHub to keep each design in your own repository: Load all designs and Sync bring them to any PC.' },
    { sel: '#btnFeedback', title: 'Tell us what to improve', text: 'Ideas, bugs or questions go straight to the developer. 🎬 What\'s new opens the welcome, this tour and every update again.' },
  ];
  let tourEl = null, tourI = 0, tourView = null;
  const visibleEl = sel => { for (const s of [].concat(sel)) { const e = $(s); if (e && e.getClientRects().length && e.offsetParent !== null) return e; } return null; };
  function tour() {
    if (tourEl) return;
    tourView = document.querySelector('.tab.active') ? document.querySelector('.tab.active').dataset.view : null;
    tourEl = document.createElement('div'); tourEl.className = 'tour';
    tourEl.innerHTML = '<div class="tour-hole"></div><div class="tour-card"><div class="tour-n muted small"></div><b class="tour-t"></b><p class="tour-x small"></p><div class="row"><button class="tour-back">Back</button><button class="tour-next primary">Next</button><span style="flex:1"></span><button class="tour-skip">Skip tour</button></div></div>';
    document.body.appendChild(tourEl);
    tourEl.querySelector('.tour-next').onclick = () => go(tourI + 1, 1);
    tourEl.querySelector('.tour-back').onclick = () => go(tourI - 1, -1);
    tourEl.querySelector('.tour-skip').onclick = endTour;
    window.addEventListener('resize', place); document.addEventListener('keydown', tourKey);
    go(0, 1);
  }
  function tourKey(e) { if (!tourEl) return; if (e.key === 'Escape') endTour(); else if (e.key === 'ArrowRight') go(tourI + 1, 1); else if (e.key === 'ArrowLeft') go(tourI - 1, -1); }
  function go(i, dir) {
    if (i >= STEPS.length) return endTour();
    if (i < 0) i = 0;
    const s = STEPS[i]; if (s.view && typeof App !== 'undefined' && App.showView) App.showView(s.view);
    tourI = i;
    setTimeout(() => {
      if (!tourEl) return;
      if (!visibleEl(s.sel)) { if (i + dir >= 0 && i + dir <= STEPS.length) return go(i + dir, dir); }
      tourEl.querySelector('.tour-n').textContent = (i + 1) + ' / ' + STEPS.length;
      tourEl.querySelector('.tour-t').textContent = s.title; tourEl.querySelector('.tour-x').textContent = s.text;
      tourEl.querySelector('.tour-back').disabled = i === 0;
      tourEl.querySelector('.tour-next').textContent = i === STEPS.length - 1 ? 'Done' : 'Next';
      place();
    }, s.view ? 250 : 0);
  }
  function place() {
    if (!tourEl) return;
    const t = visibleEl(STEPS[tourI].sel), hole = tourEl.querySelector('.tour-hole'), card = tourEl.querySelector('.tour-card');
    const R = t ? t.getBoundingClientRect() : { left: innerWidth / 2 - 60, top: innerHeight / 2 - 20, width: 120, height: 40 }, pad = 6;
    Object.assign(hole.style, { left: R.left - pad + 'px', top: R.top - pad + 'px', width: R.width + 2 * pad + 'px', height: R.height + 2 * pad + 'px' });
    const cw = Math.min(340, innerWidth - 24), below = R.top + R.height + 14 + 170 < innerHeight;
    card.style.width = cw + 'px';
    card.style.left = Math.max(12, Math.min(innerWidth - cw - 12, R.left + R.width / 2 - cw / 2)) + 'px';
    card.style.top = (below ? R.top + R.height + 14 : Math.max(12, R.top - 14 - card.offsetHeight)) + 'px';
  }
  function endTour() {
    if (!tourEl) return;
    tourEl.remove(); tourEl = null; window.removeEventListener('resize', place); document.removeEventListener('keydown', tourKey);
    store.set('cp.tourDone', '1');
    if (tourView && typeof App !== 'undefined' && App.showView) App.showView(tourView);
    runAfter();
  }

  // ---------- feedback to the developer (kept privately on the CircuitPilot relay; GitHub issue as a fallback) ----------
  let fbEl = null;
  function feedback() {
    if (!fbEl) {
      fbEl = document.createElement('div'); fbEl.id = 'fbModal'; fbEl.className = 'modal hidden';
      fbEl.innerHTML = `<div class="dlg fb-dlg"><div class="row-h"><h2>Send feedback</h2><button id="fbClose" title="Close">✕</button></div>
        <p class="muted small" style="margin:4px 0 8px">Ideas, bugs, questions — they go straight to the developer and help decide what comes next. Thank you!</p>
        <div class="seg" id="fbKind"><button data-k="idea" class="on">💡 Idea</button><button data-k="bug">🐞 Bug</button><button data-k="question">❓ Question</button><button data-k="praise">👍 Praise</button></div>
        <textarea id="fbText" rows="6" placeholder="What would make CircuitPilot better for you? For a bug: what you did, what happened, what you expected." style="width:100%;margin-top:8px"></textarea>
        <label class="small">Your e-mail (optional, only if you want an answer)<input id="fbMail" type="email" placeholder="you@example.com" style="width:100%"></label>
        <label class="chk small"><input type="checkbox" id="fbCtx" checked> Include the project name, the open view and the app version (not the design itself)</label>
        <div class="row" style="margin-top:8px"><button id="fbSend" class="primary">Send</button><span id="fbMsg" class="small"></span></div></div>`;
      document.body.appendChild(fbEl);
      fbEl.querySelector('#fbKind').onclick = e => { const b = e.target.closest('button[data-k]'); if (b) fbEl.querySelectorAll('#fbKind button').forEach(x => x.classList.toggle('on', x === b)); };
      fbEl.querySelector('#fbClose').onclick = () => fbEl.classList.add('hidden');
      fbEl.querySelector('#fbSend').onclick = sendFeedback;
    }
    fbEl.querySelector('#fbMsg').textContent = '';
    fbEl.classList.remove('hidden'); setTimeout(() => fbEl.querySelector('#fbText').focus(), 50);
  }
  async function sendFeedback() {
    const msg = fbEl.querySelector('#fbMsg'), text = fbEl.querySelector('#fbText').value.trim();
    if (!text) { msg.className = 'small bad'; msg.textContent = 'Write something first'; return; }
    const kind = (fbEl.querySelector('#fbKind button.on') || {}).dataset.k || 'idea', ctx = fbEl.querySelector('#fbCtx').checked;
    const S = typeof Model !== 'undefined' && Model.S, view = document.querySelector('.tab.active');
    const body = { kind, text, email: fbEl.querySelector('#fbMail').value.trim(), version: VERSION + (document.body.classList.contains('static-web') ? ' web' : ' desktop'), page: location.host, project: ctx && S ? S.name : '', view: ctx && view ? view.dataset.view : '' };
    msg.className = 'small muted'; msg.textContent = 'Sending…'; fbEl.querySelector('#fbSend').disabled = true;
    try {
      const h = { 'content-type': 'application/json' }, tok = typeof GitHub !== 'undefined' && GitHub.getIdToken && GitHub.getIdToken(); if (tok) h.authorization = 'Bearer ' + tok;
      const r = await fetch(((window.CP_CONFIG && CP_CONFIG.relay) || '') + '/pool/feedback', { method: 'POST', headers: h, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
      msg.className = 'small good'; msg.textContent = 'Sent — thank you!';
      fbEl.querySelector('#fbText').value = '';
      setTimeout(() => fbEl.classList.add('hidden'), 1600);
    } catch (e) {
      // offline / blocked: the same text as a public GitHub issue the user can post
      const url = 'https://github.com/Abdelhayali/CircuitPilot/issues/new?' + new URLSearchParams({ title: '[' + kind + '] ' + text.split('\n')[0].slice(0, 80), body: text + '\n\n— CircuitPilot ' + body.version + (body.view ? ', ' + body.view + ' view' : '') });
      msg.className = 'small bad'; msg.innerHTML = `Could not send (${esc(e.message)}). <a href="${esc(url)}" target="_blank" rel="noopener">Post it on GitHub instead</a> (public).`;
    } finally { fbEl.querySelector('#fbSend').disabled = false; }
  }

  function init() {
    const fb = $('#btnFeedback'); if (fb) fb.onclick = feedback;
    const nw = $('#btnNews'); if (nw) nw.onclick = () => open('start');
  }
  return { init, start, open, close, tour, feedback, busy, after: fn => { afterClose.push(fn); }, VERSION, CHANGELOG };
})();
if (typeof window !== 'undefined') window.Welcome = Welcome;
