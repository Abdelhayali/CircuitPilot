'use strict';
// PCB drawing as a PDF (jsPDF, vector): top layer, bottom layer, both layers, assembly drawings and the parts list.
// Board coordinates are mm with y down, the same as the PDF page, so everything is drawn at true scale (1:1)
// whenever the board fits on A4; bigger boards are scaled to fit and the scale is printed in the title block.
const PcbPdf = (() => {
  let libs = null;
  function loadLibs() {
    if (window.jspdf && window.jspdf.jsPDF && window.jspdf.jsPDF.API.autoTable) return Promise.resolve();
    if (!libs) {
      const add = src => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load the PDF library (needs internet)')); document.head.appendChild(s); });
      libs = (window.jspdf ? Promise.resolve() : add('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'))
        .then(() => window.jspdf.jsPDF.API.autoTable ? null : add('https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js'))
        .catch(e => { libs = null; throw e; });
    }
    return libs;
  }
  const COL = { top: [200, 40, 40], bot: [40, 80, 200], topPour: [244, 205, 205], botPour: [205, 215, 245], pad: [150, 150, 150], padTop: [200, 120, 60], hole: [255, 255, 255], silk: [20, 20, 20], edge: [0, 0, 0], faint: [200, 200, 200] };

  // opts.blob: return the PDF instead of downloading it (exports for the copilots)
  async function exportPdf(opts = {}) {
    const S = Model.S, cs = Pcb.placed();
    if (!cs.length || !S.board.w) throw new Error('No PCB yet: create the PCB first (PCB tab)');
    await loadLibs();
    const W = S.board.w, H = S.board.h, land = W > H * 1.1;
    const P = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4', orientation: land ? 'landscape' : 'portrait', compress: true });
    const PW = P.internal.pageSize.getWidth(), PH = P.internal.pageSize.getHeight(), M = 12, TB = 24;   // margin, title block
    // drawing pages: the board as large as the page allows (easy to read); one extra page at true size (1:1)
    const kFit = Math.min((PW - 2 * M) / W, (PH - 2 * M - TB) / H, 12);
    let k = kFit, ox = 0, oy = 0;
    const setScale = kk => { k = kk; ox = (PW - W * k) / 2; oy = M + (PH - 2 * M - TB - H * k) / 2; };
    setScale(kFit);
    const X = x => ox + x * k, Y = y => oy + y * k;
    const fmt = v => +(+v).toFixed(2);
    const idx = Model.pinIndex(), pads = cs.flatMap(c => Pcb.padsOf(c, idx)), outline = Pcb.boardPoly();
    const date = new Date().toISOString().slice(0, 10);
    const scaleTxt = () => Math.abs(k - 1) < 1e-6 ? 'Scale 1:1 - print at 100% ("actual size")' : k > 1 ? `Scale ${+k.toFixed(2)}:1 (enlarged)` : `Scale 1:${+(1 / k).toFixed(2)} (reduced to fit)`;
    let pageNo = 0;
    const newPage = () => { if (pageNo++) P.addPage(); };
    const rgb = c => P.setDrawColor(...c), fill = c => P.setFillColor(...c);
    function poly(pts, style, closed = true) {
      if (pts.length < 2) return;
      const d = []; for (let i = 1; i < pts.length; i++) d.push([(pts[i][0] - pts[i - 1][0]) * k, (pts[i][1] - pts[i - 1][1]) * k]);
      P.lines(d, X(pts[0][0]), Y(pts[0][1]), [1, 1], style, closed);
    }
    function polyline(pts, w, c) { rgb(c); P.setLineWidth(Math.max(0.05, w * k)); P.setLineCap('round'); P.setLineJoin('round'); for (let i = 1; i < pts.length; i++) P.line(X(pts[i - 1][0]), Y(pts[i - 1][1]), X(pts[i][0]), Y(pts[i][1])); }
    function edge() { rgb(COL.edge); P.setLineWidth(0.25); poly(outline, 'S'); }
    function pours(layer, c) { fill(c); for (const pr of S.pcb.pours || []) if (pr.layer === layer && S.nets[pr.net]) { const pp = Pcb.pourPoly(pr); if (pp && pp.length > 2) poly(pp, 'F'); } }
    function tracks(layer, c) { for (const t of S.pcb.traces) if (t.layer === layer && t.pts.length > 1) polyline(t.pts, t.w, c); }
    function padShape(p, c) {
      fill(c);
      if (p.shape === 'round') P.circle(X(p.x), Y(p.y), p.w / 2 * k, 'F');
      else if (p.shape === 'oval') { const r = Math.min(p.w, p.h) / 2 * k; P.roundedRect(X(p.x - p.w / 2), Y(p.y - p.h / 2), p.w * k, p.h * k, r, r, 'F'); }
      else P.rect(X(p.x - p.w / 2), Y(p.y - p.h / 2), p.w * k, p.h * k, 'F');
    }
    function padsOn(layer, c) { for (const p of pads) if (!layer || p.drill || (p.layer || 'F') === layer) padShape(p, c); }
    function holes() {
      fill(COL.hole);
      for (const p of pads) if (p.drill) P.circle(X(p.x), Y(p.y), p.drill / 2 * k, 'F');
      for (const v of S.pcb.vias) P.circle(X(v.x), Y(v.y), (v.drill || 0.3) / 2 * k, 'F');
      for (const h of S.pcb.holes || []) { fill(COL.hole); rgb(COL.edge); P.setLineWidth(0.15); P.circle(X(h.x), Y(h.y), h.d / 2 * k, 'FD'); }
    }
    function vias(c) { fill(c); for (const v of S.pcb.vias) P.circle(X(v.x), Y(v.y), v.d / 2 * k, 'F'); }
    function silk(side, c = COL.silk, labels = true) {
      P.setLineCap('round');
      rgb(c); P.setLineWidth(Math.max(0.08, 0.15 * k));
      for (const p of cs) if ((Pcb.isBottom(p) ? 'B' : 'F') === side) { const b = Pcb.fpBox(p); P.rect(X(b[0]), Y(b[1]), (b[2] - b[0]) * k, (b[3] - b[1]) * k, 'S'); }
      if (labels) for (const l of Pcb.silkLabels(side)) for (const pl of l.lines) polyline(pl.length > 1 ? pl : [pl[0], pl[0]], l.w, c);
    }
    function titleBlock(title, note) {
      const y = PH - M - TB + 4;
      rgb([120, 120, 120]); P.setLineWidth(0.3); P.rect(M, y, PW - 2 * M, TB - 4);
      P.setTextColor(20, 20, 20); P.setFont('helvetica', 'bold'); P.setFontSize(12); P.text(String(S.name || 'Untitled'), M + 3, y + 7);
      P.setFontSize(10); P.text(title, M + 3, y + 13);
      P.setFont('helvetica', 'normal'); P.setFontSize(8);
      P.text(`Board ${fmt(W)} x ${fmt(H)} mm, ${cs.length} parts, ${S.pcb.traces.length} tracks, ${S.pcb.vias.length} vias`, M + 3, y + 18);
      P.text([scaleTxt(), note || ''].filter(Boolean).join(' | '), PW - M - 3, y + 7, { align: 'right' });
      P.text(`${date} | page ${pageNo} | CircuitPilot`, PW - M - 3, y + 18, { align: 'right' });
      // 10 mm scale bar to check the print scale
      const bx = PW - M - 3 - 10 * k, by = y + 12.5; rgb(COL.edge); P.setLineWidth(0.3); P.line(bx, by, bx + 10 * k, by); P.line(bx, by - 1, bx, by + 1); P.line(bx + 10 * k, by - 1, bx + 10 * k, by + 1);
      P.text('10 mm', bx - 1.5, by + 1, { align: 'right' });
    }
    // 1. top layer
    newPage(); pours('F', COL.topPour); tracks('F', COL.top); padsOn('F', COL.pad); vias(COL.pad); holes(); silk('F'); edge();
    titleBlock('Top layer - copper, pads and top silkscreen', 'seen from the top');
    // 2. bottom layer (x-ray view from the top, so it lines up with the top page)
    newPage(); pours('B', COL.botPour); tracks('B', COL.bot); padsOn('B', COL.pad); vias(COL.pad); holes(); silk('B'); edge();
    titleBlock('Bottom layer - copper, pads and bottom silkscreen', 'seen through the board from the top (bottom text reads mirrored)');
    // 3. both layers: the routing at a glance
    newPage(); tracks('B', COL.bot); tracks('F', COL.top); padsOn(null, COL.pad); vias([90, 90, 90]); holes(); silk('F', [120, 120, 120], false); edge();
    titleBlock('Both layers - routing', 'red: top tracks, blue: bottom tracks, grey: pads and vias');
    // 4. assembly drawings
    for (const side of ['F', 'B']) {
      const on = cs.filter(c => (Pcb.isBottom(c) ? 'B' : 'F') === side); if (!on.length) continue;
      newPage(); padsOn(side, [225, 225, 225]); silk(side, COL.silk); edge();
      // values under the references, small
      P.setTextColor(90, 90, 90); P.setFont('helvetica', 'normal');
      for (const c of on) { const b = Pcb.fpBox(c), fs = Math.max(3, Math.min(6, (b[2] - b[0]) * k * 1.2)); P.setFontSize(fs); P.text(/^=/.test(String(c.value || '')) ? '' : String(c.value || '').slice(0, 18), X((b[0] + b[2]) / 2), Y((b[1] + b[3]) / 2) + fs * 0.12, { align: 'center' }); }
      titleBlock(`Assembly - ${side === 'F' ? 'top' : 'bottom'} side (${on.length} parts)`, side === 'B' ? 'seen through the board from the top' : 'reference and value of every part');
    }
    // 5. true size: lay real parts on the footprints to check them
    if (kFit > 1.05) {
      setScale(1); newPage(); padsOn('F', COL.pad); vias(COL.pad); holes(); silk('F'); edge();
      titleBlock('Top side at actual size', 'check footprints by laying the real parts on this print');
      setScale(kFit);
    }
    // 6. parts list
    newPage();
    P.setTextColor(20, 20, 20); P.setFont('helvetica', 'bold'); P.setFontSize(13); P.text(`Parts list - ${S.name || 'Untitled'}`, M, M + 4);
    const rows = cs.slice().sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true })).map(c => {
      const lib = c.type === 'part' ? S.lib[c.lcsc] : null, fp = (lib && lib.footprint && lib.footprint.name) || String(c.footprint || '').replace(/^(LCSC|LIB):/, '');
      return [c.ref, String(c.value || ''), fp, Model.lcscOf(c) || '', Pcb.isBottom(c) ? 'bottom' : 'top', c.pcb.x.toFixed(2), c.pcb.y.toFixed(2), String(c.pcb.rot || 0)];
    });
    P.autoTable({ startY: M + 8, head: [['Ref', 'Value', 'Footprint', 'LCSC', 'Side', 'X (mm)', 'Y (mm)', 'Rot']], body: rows, styles: { fontSize: 7, cellPadding: 1 }, headStyles: { fillColor: [60, 60, 60] }, margin: { left: M, right: M } });
    const blob = P.output('blob');
    if (opts.blob) return { blob, pages: pageNo, scale: k };
    App.download((S.name || 'board').replace(/[^\w.-]+/g, '_') + '-pcb.pdf', blob);
    return { pages: pageNo, scale: k };
  }
  return { export: exportPdf };
})();
