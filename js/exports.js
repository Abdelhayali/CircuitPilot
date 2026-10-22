'use strict';
// File exports shared by the app (Export menu) and the copilots (export_project): BOM, JLCPCB BOM + pick-and-place,
// netlist and the project file. Pure functions of the current design (Model / Pcb), no browser needed.
const Exports = (() => {
  const q = s => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
  const slug = n => String(n || 'board').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'board';
  // JLCPCB assembly BOM: one line per value + footprint + LCSC part
  function bomJlc() {
    const S = Model.S, g = {};
    for (const c of S.components) {
      const lib = (c.lcsc && S.lib[c.lcsc]) || (c.dbfp && c.footprint === 'LCSC:' + c.dbfp && S.lib[c.dbfp]), fpn = (lib && lib.footprint && lib.footprint.name) || c.footprint;
      const k = [c.value, fpn, Model.lcscOf(c)].join('|'); (g[k] = g[k] || []).push(c.ref);
    }
    return 'Comment,Designator,Footprint,LCSC Part #\n' + Object.entries(g).map(([k, refs]) => { const [v, f, code] = k.split('|'); return [q(v), q(refs.join(',')), q(f), q(code)].join(','); }).join('\n') + '\n';
  }
  // pick-and-place in JLCPCB's CPL format: Gerber coordinates (origin bottom-left, mm), part centre = centre of its pads
  function cpl() {
    const S = Model.S, idx = Model.pinIndex(), H = S.board.h, f = v => (Math.round(v * 1000) / 1000).toFixed(3) + 'mm';
    const rows = Pcb.placed().map(c => {
      const pads = Pcb.padsOf(c, idx), x = pads.length ? pads.reduce((a, p) => a + p.x, 0) / pads.length : c.pcb.x, y = pads.length ? pads.reduce((a, p) => a + p.y, 0) / pads.length : c.pcb.y;
      return [c.ref, f(x), f(H - y), Pcb.isBottom(c) ? 'Bottom' : 'Top', ((c.pcb.rot || 0) % 360 + 360) % 360].join(',');
    });
    return 'Designator,Mid X,Mid Y,Layer,Rotation\n' + rows.join('\n') + '\n';
  }
  // plain bill of materials
  function bom() {
    const S = Model.S, g = {};
    for (const c of S.components) { const k = [c.type, c.value, c.footprint, Model.lcscOf(c) || ''].join('|'); (g[k] = g[k] || []).push(c.ref); }
    return 'Qty,References,Type,Value,Footprint,LCSC\n' + Object.entries(g).map(([k, refs]) => { const [t, v, f, l] = k.split('|'); return [refs.length, q(refs.join(' ')), t, q(v), q(f), l].join(','); }).join('\n') + '\n';
  }
  // KiCad-style netlist (export (version "E"))
  function netlist() {
    const S = Model.S;
    let s = '(export (version "E")\n  (design (source "CircuitPilot"))\n  (components\n';
    for (const c of S.components) s += `    (comp (ref "${c.ref}") (value "${String(c.value).replace(/"/g, "'")}") (footprint "${c.footprint}"))\n`;
    s += '  )\n  (nets\n';
    Object.entries(S.nets).forEach(([n, keys], i) => { s += `    (net (code "${i + 1}") (name "${n}")\n` + keys.map(k => { const d = k.lastIndexOf('.'); return `      (node (ref "${k.slice(0, d)}") (pin "${k.slice(d + 1)}"))`; }).join('\n') + ')\n'; });
    return s + '  )\n)\n';
  }
  const project = () => JSON.stringify(Model.S, null, 1);
  return { bomJlc, cpl, bom, netlist, project, slug };
})();
if (typeof module !== 'undefined') module.exports = Exports;
