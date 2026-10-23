'use strict';
// Circuit blocks: copy a group of parts (schematic + PCB placement + the tracks between them) inside a project or into
// another one. Power nets (GND, +3V3 …) stay connected, wiring inside the block gets fresh nets, nets to parts
// outside the block are left off unless keep_nets names them.
const Blocks = (() => {
  const refOf = k => k.slice(0, k.lastIndexOf('.'));
  function extract(refs) {
    const S = Model.S, want = (refs || []).map(r => String(r).trim()).filter(Boolean);
    if (!want.length) throw new Error('refs is empty — e.g. ["U3", "C5", "C6", "R4"]');
    const miss = want.filter(r => !Model.comp(r)); if (miss.length) throw new Error('No component ' + miss.join(', '));
    const set = new Set(want.map(r => Model.comp(r).ref)), comps = S.components.filter(c => set.has(c.ref)).map(c => JSON.parse(JSON.stringify(c)));
    const lib = {};
    for (const c of comps) for (const k of [c.lcsc, c.dbfp, String(c.footprint || '').replace(/^(LCSC|LIB):/, '')]) if (k && S.lib[k]) lib[k] = S.lib[k];
    const nets = [];
    for (const [n, keys] of Object.entries(S.nets)) {
      const k = keys.filter(x => set.has(refOf(x)));
      if (k.length) nets.push({ name: n, keys: k, internal: k.length === keys.length, power: Model.isPower(n) });
    }
    const inner = new Set(nets.filter(n => n.internal && !n.power).map(n => n.name));
    const traces = S.pcb.traces.filter(t => inner.has(t.net)).map(t => JSON.parse(JSON.stringify(t)));
    const vias = S.pcb.vias.filter(v => inner.has(v.net)).map(v => Object.assign({}, v));
    let sch = null, pcb = null;
    for (const c of S.components) if (set.has(c.ref)) {
      const b = Model.bbox(c); sch = sch ? [Math.min(sch[0], b[0]), Math.min(sch[1], b[1]), Math.max(sch[2], b[2]), Math.max(sch[3], b[3])] : b.slice();
      if (c.pcb && S.board.w) { const q = Pcb.fpBox(c); pcb = pcb ? [Math.min(pcb[0], q[0]), Math.min(pcb[1], q[1]), Math.max(pcb[2], q[2]), Math.max(pcb[3], q[3])] : q.slice(); }
    }
    const sheets = [...new Set(comps.map(c => c.sheet || 0))];
    return { comps, lib, nets, traces, vias, sch, pcb, sheet: sheets.length === 1 ? sheets[0] : 0 };
  }
  // o: sch_offset [dx, dy] (schematic units), pcb_offset [dx, dy] (mm) or place: "free" (next free board area),
  //    sheet (1-based; 0 = main), keep_nets [names to stay connected], suffix (for renamed nets)
  function insert(B, o = {}) {
    const S = Model.S, map = {}, keep = new Set(o.keep_nets || []);
    for (const [k, d] of Object.entries(B.lib || {})) if (!S.lib[k]) S.lib[k] = d;
    const sameSheetBlock = B.sch && o.sch_offset == null;
    const sdx = o.sch_offset ? +o.sch_offset[0] : sameSheetBlock ? Math.ceil((B.sch[2] - B.sch[0] + 80) / 10) * 10 : 0, sdy = o.sch_offset ? +o.sch_offset[1] : 0;
    const onBoard = !!(B.pcb && S.board.w) && o.place !== 'none';
    let pdx = 0, pdy = 0;
    if (onBoard && Array.isArray(o.pcb_offset)) { pdx = +o.pcb_offset[0]; pdy = +o.pcb_offset[1]; }
    else if (onBoard) { pdx = +(B.pcb[2] - B.pcb[0] + 2).toFixed(3); }
    for (const c0 of B.comps) {
      const c = JSON.parse(JSON.stringify(c0)), prefix = c0.ref.replace(/\d+$/, '') || 'U';
      c.ref = Model.nextRef(prefix); map[c0.ref] = c.ref;
      c.x = Math.round((c0.x + sdx) / 10) * 10; c.y = Math.round((c0.y + sdy) / 10) * 10;
      if (o.sheet != null) { if (+o.sheet > 0) c.sheet = +o.sheet; else delete c.sheet; }
      if (c.pcb && onBoard) { c.pcb.x = +(c0.pcb.x + pdx).toFixed(3); c.pcb.y = +(c0.pcb.y + pdy).toFixed(3); delete c.pcb.locked; delete c.pcbEdge; }
      else delete c.pcb;
      S.components.push(c);
    }
    const rk = k => { const i = k.lastIndexOf('.'); return map[k.slice(0, i)] + k.slice(i); };
    const netMap = {}, sfx = o.suffix ? String(o.suffix).replace(/[^\w+-]/g, '') : '';
    for (const n of B.nets) {
      // power nets and named ones stay connected; other nets: inside the block → fresh net, to outside parts → left off
      if (!(n.power || keep.has(n.name)) && !n.internal) continue;
      if (n.keys.length < 2 && !n.power && !keep.has(n.name)) continue;
      let name = n.name;
      if (!n.power && !keep.has(n.name)) {
        if (sfx && !S.nets[n.name + '_' + sfx]) name = n.name + '_' + sfx;
        else if (/^N\$\d+$/.test(n.name)) name = Model.autoNetName();
        else { let i = 2; while (S.nets[n.name + '_' + i]) i++; name = n.name + '_' + i; }
      }
      netMap[n.name] = name;
      S.nets[name] = [...new Set([...(S.nets[name] || []), ...n.keys.map(rk)])];
    }
    const refs = Object.values(map);
    let moved = null;
    let placeNote;
    if (onBoard && o.place === 'free') {
      try { moved = Pcb.placeFree(refs, { group: true, near: o.near }); }
      catch (e) {   // no room for the block in one piece: each part to its own free spot (tracks are then not copied)
        const r = Pcb.placeFree(refs, { near: o.near }); moved = { dx: NaN, dy: NaN };
        placeNote = 'No free area for the block in one piece — its parts were placed one by one' + (r.failed ? ` (no room for ${r.failed.join(', ')})` : '') + '; route_pcb to connect them';
      }
    }
    let tracks = 0;
    if (onBoard) {
      const ddx = moved ? moved.dx : pdx, ddy = moved ? moved.dy : pdy;
      if (isFinite(ddx)) for (const t of B.traces) if (netMap[t.net]) { S.pcb.traces.push(Object.assign({}, t, { net: netMap[t.net], pts: t.pts.map(q => [+(q[0] + ddx).toFixed(4), +(q[1] + ddy).toFixed(4)]) })); tracks++; }
      if (isFinite(ddx)) for (const v of B.vias) if (netMap[v.net]) S.pcb.vias.push(Object.assign({}, v, { net: netMap[v.net], x: +(v.x + ddx).toFixed(4), y: +(v.y + ddy).toFixed(4) }));
    }
    const left = B.nets.filter(n => !netMap[n.name] && !n.internal).map(n => n.name);
    return { parts: map, nets: netMap, tracks_copied: tracks, on_pcb: onBoard, not_connected: left.length ? left : undefined,
      placement: placeNote, overlaps: onBoard ? Pcb.legalCheck(refs) : undefined,
      note: left.length ? 'These nets went to parts outside the block and were left off — connect the copy yourself, or copy again with keep_nets' : undefined };
  }
  return { extract, insert };
})();
if (typeof module !== 'undefined') module.exports = Blocks;
