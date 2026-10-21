'use strict';
// KiCad official footprint library (gitlab.com/kicad/libraries/kicad-footprints) for the part editor.
// data/kicad-footprints.txt lists every footprint (tools/kicad_footprint_index.py); a chosen .kicad_mod file is
// downloaded from GitLab (CORS enabled, no key) and converted to a CircuitPilot footprint (mm, y down, unrotated pads).
const KiCad = (() => {
  const RAW = 'https://gitlab.com/api/v4/projects/kicad%2Flibraries%2Fkicad-footprints/repository/files/';
  let names = null, loading = null;
  const r4 = v => +(+v).toFixed(4);

  function index() {
    if (names) return Promise.resolve(names);
    if (!loading) loading = fetch('data/kicad-footprints.txt').then(r => { if (!r.ok) throw new Error('KiCad footprint list not found (' + r.status + ')'); return r.text(); })
      .then(t => (names = t.split('\n').filter(Boolean))).finally(() => { loading = null; });
    return loading;
  }
  // every word must match the library or footprint name ("soic 8" finds Package_SO.pretty/SOIC-8_3.9x4.9mm_P1.27mm)
  async function search(q, limit = 60) {
    const list = await index(), words = String(q || '').toLowerCase().split(/[\s,]+/).filter(Boolean);
    if (!words.length) return [];
    const hits = list.filter(n => { const t = n.toLowerCase(); return words.every(w => t.includes(w)); });
    const name = n => n.slice(n.indexOf('/') + 1).toLowerCase();
    hits.sort((a, b) => (name(a).startsWith(words[0]) ? 0 : 1) - (name(b).startsWith(words[0]) ? 0 : 1) || name(a).length - name(b).length || a.localeCompare(b));
    return hits.slice(0, limit);
  }
  async function load(path) {
    const r = await fetch(RAW + encodeURIComponent(path + '.kicad_mod') + '/raw?ref=master');
    if (!r.ok) throw new Error('Could not download ' + path + ' from the KiCad library (' + r.status + ')');
    const fp = parse(await r.text());
    fp.name = path.slice(path.indexOf('/') + 1);
    fp.source = 'KiCad library: ' + path;
    return fp;
  }

  // ---------- .kicad_mod (s-expression) ----------
  function sexpr(text) {
    let i = 0;
    const read = () => {
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text[i] === '(') {
        i++; const list = [];
        for (;;) { while (i < text.length && /\s/.test(text[i])) i++; if (i >= text.length) return list; if (text[i] === ')') { i++; return list; } list.push(read()); }
      }
      if (text[i] === '"') {
        let s = ''; i++;
        while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; s += text[i++]; }
        i++; return s;
      }
      const st = i; while (i < text.length && !/[\s()]/.test(text[i])) i++;
      return text.slice(st, i);
    };
    return read();
  }
  const kids = (node, tag) => node.filter(x => Array.isArray(x) && x[0] === tag);
  const kid = (node, tag) => kids(node, tag)[0];
  const nums = node => (node || []).slice(1).map(Number);
  function pointsOf(g) {   // outline points of a graphic item, for the body box
    const pts = [];
    for (const t of ['start', 'end', 'mid', 'center']) { const k = kid(g, t); if (k) pts.push(nums(k)); }
    if (g[0] === 'fp_circle' || g[0] === 'gr_circle') { const c = nums(kid(g, 'center')), e = nums(kid(g, 'end')); if (c.length && e.length) { const rr = Math.hypot(e[0] - c[0], e[1] - c[1]); pts.push([c[0] - rr, c[1] - rr], [c[0] + rr, c[1] + rr]); } }
    const p = kid(g, 'pts'); if (p) for (const xy of kids(p, 'xy')) pts.push(nums(xy));
    return pts.filter(q => q.length >= 2 && q.every(isFinite));
  }
  const box = pts => pts.length ? [Math.min(...pts.map(q => q[0])), Math.min(...pts.map(q => q[1])), Math.max(...pts.map(q => q[0])), Math.max(...pts.map(q => q[1]))] : null;

  function parse(text) {
    const root = sexpr(text);
    if (!Array.isArray(root) || !/^(footprint|module)$/.test(root[0])) throw new Error('Not a KiCad footprint file');
    const pads = []; let skipped = 0;
    for (const p of kids(root, 'pad')) {
      const [, num, type, shape] = p, at = nums(kid(p, 'at')), size = nums(kid(p, 'size')), layers = (kid(p, 'layers') || []).slice(1).join(' ');
      if (type === 'np_thru_hole' || !/Cu/.test(layers)) { skipped++; continue; }   // mounting holes without copper, paste-only apertures
      let w = size[0] || 0.1, h = size[1] || size[0] || 0.1;
      if (shape === 'custom') {   // anchor pad + drawn primitives: use their outline box
        const pr = kid(p, 'primitives'), pts = [[-w / 2, -h / 2], [w / 2, h / 2]];
        if (pr) for (const g of pr.slice(1)) if (Array.isArray(g)) pts.push(...pointsOf(g));
        const b = box(pts); w = b[2] - b[0]; h = b[3] - b[1];
      }
      const a = ((((at[2] || 0) % 180) + 180) % 180);
      if (Math.abs(a - 90) < 0.5) [w, h] = [h, w];
      else if (a > 0.5 && a < 179.5) { const t = a * Math.PI / 180, c = Math.abs(Math.cos(t)), s = Math.abs(Math.sin(t)); [w, h] = [w * c + h * s, w * s + h * c]; }
      const pad = { num: String(num), x: r4(at[0] || 0), y: r4(at[1] || 0), w: r4(w), h: r4(h), shape: shape === 'circle' ? 'round' : shape === 'oval' ? (Math.abs(w - h) < 1e-6 ? 'round' : 'oval') : 'rect' };
      const d = kid(p, 'drill');
      if (type === 'thru_hole' && d) { const v = d.slice(1).filter(x => !Array.isArray(x) && x !== 'oval').map(Number).filter(isFinite); if (v.length) pad.drill = r4(Math.min(...v)); }
      pads.push(pad);
    }
    if (!pads.length) throw new Error('This KiCad footprint has no copper pads');
    // body: courtyard, else fabrication outline, else the pads
    const gfx = ['fp_line', 'fp_rect', 'fp_circle', 'fp_arc', 'fp_poly'].flatMap(t => kids(root, t));
    const onLayer = re => box(gfx.filter(g => re.test((kid(g, 'layer') || [])[1] || '')).flatMap(pointsOf));
    const body = onLayer(/^F\.CrtYd$/) || onLayer(/^F\.Fab$/) || box(pads.flatMap(p => [[p.x - p.w / 2, p.y - p.h / 2], [p.x + p.w / 2, p.y + p.h / 2]]));
    const descr = kid(root, 'descr');
    return { name: String(root[1]), pads, body: body.map(r4), description: descr ? String(descr[1]) : '', skipped };
  }

  return { index, search, load, parse };
})();
if (typeof module !== 'undefined') module.exports = KiCad;
