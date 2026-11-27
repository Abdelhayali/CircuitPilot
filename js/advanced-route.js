'use strict';

// The KiCad board is an intermediate file. Only validated route geometry comes back.
(() => {
  const $ = id => document.getElementById(id);
  const layers = {F: 'F.Cu', B: 'B.Cu'};
  const quote = s => JSON.stringify(String(s));
  const number = n => {
    if (!Number.isFinite(n)) throw new Error('The PCB has invalid coordinates or dimensions.');
    return n.toFixed(6).replace(/\.?0+$/, '') || '0';
  };
  const xy = p => p.map(number).join(' ');
  const coords = (key, p) => '(' + key + ' ' + xy(p) + ')';
  const label = (id, value) => $(id).textContent = value;
  let preview, busy = false, available = false;

  const pinned = v => v.manual || v.locked || v.thermal;
  const point = p => [p.x, p.y];
  const segments = traces => traces.flatMap(t => t.pts.slice(1).map((p,i) =>
    ({net: t.net || null, layer: t.layer, w: t.w, pts: [t.pts[i], p]})));

  function prepare() {
    const S = Model.S, R = Pcb.rules(), parts = Pcb.placed();
    if (+R.layers !== 2) throw new Error('Advanced Route currently supports two-layer boards.');
    if (!S.board.w || !parts.length || Pcb.pendingFootprints().length) {
      throw new Error('Update from schematic and place the parts before routing.');
    }
    const mode = $('advancedRouteMode').value;
    const pair = mode === 'pair' ? [$('advancedRoutePositive').value, $('advancedRouteNegative').value] : [];
    const idx = Model.pinIndex(), padGroups = parts.map(c => ({c, pads: Pcb.padsOf(c,idx)}));
    const pads = padGroups.flatMap(p => p.pads);
    const outline = Pcb.boardPoly();
    const clearance = Math.max(R.clearance, Pcb.padCl(R), Pcb.viaCl(R), +R.minClearance || 0);
    const gap = +$('advancedRouteGap').value, skew = +$('advancedRouteSkew').value;
    if (pair.length && (pair[0] === pair[1] || pair.some(n => !n || pads.filter(p => p.net === n).length !== 2))) {
      throw new Error('Select two different nets with exactly two PCB pads each.');
    }
    if (pair.length && (!(gap >= clearance) || !(skew >= .001))) {
      throw new Error('Enter a pair gap of at least ' + clearance + ' mm and a positive length tolerance.');
    }
    const retain = v => pinned(v) || (pair.length && !pair.includes(v.net));
    const tracks = S.pcb.traces.filter(retain), vias = S.pcb.vias.filter(retain);
    if (pair.length && [...tracks,...vias].some(v => pair.includes(v.net))) {
      throw new Error('The selected pair contains locked or hand-routed copper. Choose a pair with editable routes.');
    }
    const names = [...new Set(pads.map(p => p.net).filter(Boolean))];
    const nets = new Map(names.map((n,i) => [n, {id: i+1, name: n === pair[0] ? 'CP_PAIR_P' :
      n === pair[1] ? 'CP_PAIR_N' : 'CP_N' + (i+1)}]));
    const rules = {
      width: Math.max(R.traceWidth, +R.minTraceWidth || 0), clearance,
      edge: Math.max(R.edgeClearance, +R.minEdgeClearance || 0), holes: +R.minHoleToHole || 0,
      via: Math.max(R.viaDiameter, +R.minViaDiameter || 0), drill: Math.max(R.viaDrill, +R.minViaDrill || 0),
      noViaInPad: !!R.noViaInPad, neckDown: !!R.neckDown
    };
    rules.via = Math.max(rules.via, rules.drill + 2 * (+R.minAnnularRing || 0));
    const widthOf = n => Math.max(Pcb.netWidth(n), +R.minTraceWidth || 0);
    if (pair.length) rules.width = Math.max(...pair.map(widthOf));
    const widths = Object.fromEntries(names.filter(n => widthOf(n) !== rules.width).map(n => [nets.get(n).name,widthOf(n)]));
    const netId = n => nets.get(n)?.id || 0;
    const net = n => '(net ' + netId(n) + ')';
    const outlineLayer = '(stroke (width 0.05) (type default)) (layer "Edge.Cuts")';
    const rows = [
      '(kicad_pcb (version 20240108) (generator "CircuitPilot")',
      '(general (thickness ' + number(Pcb.boardThickness()) + '))',
      '(paper "A4") (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (36 "B.SilkS" user) (37 "F.SilkS" user) (44 "Edge.Cuts" user))',
      '(setup (pad_to_mask_clearance 0))', '(net 0 "")',
      ...[...nets.values()].map(n => '(net ' + n.id + ' ' + quote(n.name) + ')')
    ];
    outline.forEach((p,i) => rows.push('(gr_line ' + coords('start', p) + ' ' +
      coords('end', outline[(i+1) % outline.length]) + ' ' + outlineLayer + ')'));
    for (const h of S.pcb.holes || []) rows.push('(gr_circle ' + coords('center',point(h)) + ' ' +
      coords('end',[h.x+h.d/2,h.y]) + ' ' + outlineLayer + ' (fill none))');
    for (const {c,pads: group} of padGroups) {
      const b = Pcb.isBottom(c), face = b ? 'B' : 'F';
      rows.push('(footprint "CircuitPilot:BoardPart" (layer ' + quote(layers[face]) + ') (at 0 0)',
        '(fp_text reference ' + quote(c.ref) + ' (at 0 0) (layer "' + face +
        '.SilkS") hide (effects (font (size 1 1) (thickness 0.15))))');
      for (const p of group) {
        const shp = p.shape === 'oval' ? 'oval' : p.shape === 'round' ? 'circle' : 'rect';
        const size = [p.w, shp === 'circle' ? p.w : p.h], name = nets.get(p.net)?.name || '';
        rows.push('(pad ' + quote(p.num) + (p.drill ? ' thru_hole ' : ' smd ') + shp + ' ' +
          coords('at',point(p)) + ' ' + coords('size',size) + ' ' +
          (p.drill ? '(drill ' + number(p.drill) + ') (layers "*.Cu" "*.Mask")' :
            '(layers ' + quote(layers[p.layer]) + ')') +
          (name ? ' (net ' + netId(p.net) + ' ' + quote(name) + ')' : '') + ')');
      }
      rows.push(')');
    }
    for (const t of segments(tracks)) {
      if (!layers[t.layer] || (t.net && !nets.has(t.net))) throw new Error('An existing trace cannot be transferred.');
      rows.push('(segment ' + coords('start',t.pts[0]) + ' ' + coords('end',t.pts[1]) +
        ' (width ' + number(t.w) + ') (layer ' + quote(layers[t.layer]) + ') ' + net(t.net) + ' (locked yes))');
    }
    for (const v of vias) {
      if (v.net && !nets.has(v.net)) throw new Error('An existing via cannot be transferred.');
      rows.push('(via ' + coords('at',point(v)) + ' (size ' + number(v.d) + ') (drill ' + number(v.drill) +
        ') (layers "F.Cu" "B.Cu") ' + net(v.net) + ' (locked yes))');
    }
    const polygon = pts => '(polygon (pts ' + pts.map(p => coords('xy',p)).join(' ') + '))';
    for (const k of Pcb.keepouts()) {
      if (!k.pts || k.pts.length < 3 || !(k.tracks || k.vias || k.pours)) continue;
      const layer = layers[k.layer] ? '(layer ' + quote(layers[k.layer]) + ')' : '(layers "F.Cu" "B.Cu")';
      rows.push('(zone (net 0) (net_name "") ' + layer + ' (hatch edge 0.5) (keepout (tracks ' +
        (k.tracks ? 'not_allowed' : 'allowed') + ') (vias ' + (k.vias ? 'not_allowed' : 'allowed') +
        ') (pads allowed) (copperpour ' + (k.pours ? 'not_allowed' : 'allowed') + ') (footprints allowed)) ' +
        polygon(k.pts) + ')');
    }
    for (const pr of S.pcb.pours || []) {
      const pts = Pcb.pourPoly(pr), name = nets.get(pr.net)?.name;
      if (!name || !layers[pr.layer] || pts.length < 3) throw new Error('A copper pour cannot be transferred.');
      rows.push('(zone ' + net(pr.net) + ' (net_name ' + quote(name) + ') (layer ' + quote(layers[pr.layer]) +
        ') (hatch edge 0.5) (connect_pads (clearance ' + number(Pcb.pourCl(R,pr)) +
        ')) (min_thickness 0.1) (fill yes (thermal_gap 0.3) (thermal_bridge_width 0.3)) ' + polygon(pts) + ')');
    }
    rows.push(')');
    return {body: {mode, board: rows.join('\n'), rules, widths, gap, skew}, pair, nets, outline, pads, tracks, vias, widthOf};
  }

  const trackKey = t => JSON.stringify([t.net,t.layer,number(t.w),...t.pts.map(xy).sort()]);
  const viaKey = v => JSON.stringify([v.net,xy(point(v)),number(v.d),number(v.drill)]);
  function additions(original, output, key) {
    const encoded = new Map();
    for (const a of original) {
      const k = key(a);
      encoded.set(k,(encoded.get(k) || 0) + 1);
    }
    const extra = output.filter(a => {
      const k = key(a), count = encoded.get(k);
      if (count === 1) encoded.delete(k);
      else if (count) encoded.set(k,count-1);
      return !count;
    });
    if (encoded.size) throw new Error('The router altered existing copper that was marked to keep.');
    return extra;
  }

  function candidate(ctx, text) {
    const original = Model.S.pcb;
    const root = KiCadImport._internal.parse(text);
    if (!Array.isArray(root) || root[0] !== 'kicad_pcb') throw new Error('Invalid board returned by the router.');
    for (const n of root) {
      if (!Array.isArray(n)) continue;
      if (['segment','arc'].includes(n[0]) && !Object.values(layers).includes(n.find(k => Array.isArray(k) && k[0] === 'layer')?.[1])) {
        throw new Error('The router returned traces on an unsupported layer.');
      }
      if (n[0] === 'via') {
        const ls = n.find(k => Array.isArray(k) && k[0] === 'layers')?.slice(1);
        if (ls?.length !== 2 || !ls.includes('F.Cu') || !ls.includes('B.Cu')) throw new Error('The router returned an unsupported via.');
      }
    }
    const out = KiCadImport._internal.readPcb(text, []);
    const names = new Map([...ctx.nets].map(([actual,n]) => [n.name,actual]));
    const decoded = n => {
      if (!n) return null;
      if (!names.has(n)) throw new Error('The router returned an unknown net.');
      return names.get(n);
    };
    const t = additions(segments(ctx.tracks), segments(out.tracks.map(v => ({...v,net:decoded(v.net)}))), trackKey);
    const v = additions(ctx.vias, out.vias.map(q => ({...q,net:decoded(q.net)})), viaKey);
    if (!t.length && !v.length) throw new Error('KiCadRoutingTools returned no new routes.');
    if (ctx.pair.length && [...t,...v].some(q => !ctx.pair.includes(q.net))) {
      throw new Error('The router added copper outside the selected pair.');
    }
    if (t.some(q => !q.net || q.w <= 0) || v.some(q => !q.net || q.drill <= 0 || q.d < q.drill)) {
      throw new Error('The router returned invalid copper geometry.');
    }
    const issues = [];
    const requested = ctx.body.rules;
    if (!requested.neckDown) {
      const nets = [...new Set(t.filter(q => q.w < ctx.widthOf(q.net) - .001).map(q => q.net))];
      if (nets.length) issues.push('Tracks below the requested width on ' + nets.join(', ') + '.');
    }
    if (v.some(q => q.d < requested.via - .001 || q.drill < requested.drill - .001)) {
      issues.push('The router used vias smaller than the requested ' + requested.via + '/' + requested.drill + ' mm.');
    }
    const pcb = {...original, traces: [...ctx.tracks,...t], vias: [...ctx.vias,...v], routed: {}};
    const before = score(ctx.pair);
    let after;
    try {
      Model.S.pcb = pcb;
      after = score(ctx.pair);
      pcb.routed = Object.fromEntries(Object.entries(Pcb.connectivity()).filter(([,n]) => n.complete).map(([n]) => [n,true]));
    } finally {
      Model.S.pcb = original;
    }
    if (after.unrouted.some(n => !before.unrouted.includes(n))) issues.push('The preview disconnects a previously routed net.');
    const sig = q => JSON.stringify([q.type,q.msg,q.x,q.y]);
    const known = new Map();
    for (const q of before.failures) known.set(sig(q),(known.get(sig(q)) || 0) + 1);
    const newErrors = after.failures.filter(q => {
      const k = sig(q), count = known.get(k) || 0;
      if (count) known.set(k,count-1);
      return !count;
    });
    issues.push(...newErrors.map(q => q.msg));
    if (ctx.pair.length) {
      if (ctx.pair.some(n => after.unrouted.includes(n))) issues.push('Both nets in the pair must be fully routed.');
      else if (after.skew > ctx.body.skew + .000001) issues.push('The pair exceeds the requested trace length difference.');
    }
    return {pcb, ctx, beforePcb: original, before, after, issues};
  }

  function score(pair) {
    const pcb = Model.S.pcb, s = Pcb.status(), d = Pcb.drc();
    const length = net => pcb.traces.filter(t => t.net === net).reduce((sum,t) =>
      sum + t.pts.slice(1).reduce((acc,p,i) => acc + Math.hypot(p[0]-t.pts[i][0],p[1]-t.pts[i][1]),0),0);
    return {unrouted: s.unrouted, vias: s.vias, length: s.trace_length_mm, warnings: d.warnings,
      failures: d.violations.filter(q => q.severity === 'error' && q.type !== 'unrouted'),
      skew: pair.length ? Math.abs(length(pair[0])-length(pair[1])) : null};
  }

  function draw(after) {
    const map = $('advancedRouteMap'), ctx = preview.ctx, pcb = after ? preview.pcb : preview.beforePcb;
    const {w,h} = Model.S.board;
    map.setAttribute('viewBox',[-1,-1,w+2,h+2].join(' '));
    const items = [];
    const shape = (tag, attrs) => {
      const elem = document.createElementNS('http://www.w3.org/2000/svg',tag);
      for (const [k,v] of Object.entries(attrs)) elem.setAttribute(k,v);
      items.push(elem);
    };
    const points = path => path.map(p => p.join(',')).join(' ');
    shape('polygon',{points:points(ctx.outline),fill:'none',stroke:'#91a7bb','stroke-width':'.15'});
    for (const p of ctx.pads) shape('rect',{x:p.x-p.w/2,y:p.y-p.h/2,width:p.w,height:p.h,
      fill:p.layer === 'B' ? '#3b68aa' : p.layer === 'F' ? '#a34750' : '#9ca9bb'});
    for (const t of pcb.traces) shape('polyline',{points:points(t.pts),fill:'none',
      stroke:t.layer === 'B' ? '#65a4ff' : '#ff6570','stroke-width':t.w,'stroke-linecap':'round','stroke-linejoin':'round'});
    for (const v of pcb.vias) shape('circle',{cx:v.x,cy:v.y,r:v.d/2,fill:'#ffd465'});
    map.replaceChildren(...items);
    $('advancedRouteBefore').setAttribute('aria-pressed',String(!after));
    $('advancedRouteAfter').setAttribute('aria-pressed',String(after));
    map.setAttribute('aria-label',after ? 'Proposed PCB route' : 'Current PCB route');
  }

  function show() {
    const {before,after,issues} = preview, table = $('advancedRouteScore');
    table.replaceChildren();
    const row = table.createTHead().insertRow();
    for (const text of ['Routing check','Current','Preview']) {
      const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = text; row.append(cell);
    }
    const items = [
      ['Unrouted nets', before.unrouted.length, after.unrouted.length],
      ['Other DRC errors', before.failures.length, after.failures.length],
      ['DRC warnings', before.warnings, after.warnings],
      ['Vias',before.vias,after.vias],
      ['Trace length (mm)',before.length,after.length]
    ];
    if (after.skew !== null) items.push(['Pair length difference (mm)', before.skew.toFixed(3), after.skew.toFixed(3)]);
    const body = table.createTBody();
    for (const values of items) {
      const r = body.insertRow();
      for (const value of values) r.insertCell().textContent = value;
    }
    $('advancedRouteResult').hidden = false;
    const list = $('advancedRouteIssueList'), flagged = issues.length > 0;
    list.hidden = !flagged;
    list.open = false;
    const entries = document.createDocumentFragment();
    for (const issue of issues) {
      const item = document.createElement('li');
      item.textContent = issue;
      entries.append(item);
    }
    $('advancedRouteIssueItems').replaceChildren(entries);
    $('advancedRouteRepairLabel').hidden = !flagged;
    $('advancedRouteRepair').checked = false;
    updateApply();
    const connections = after.unrouted.length ? 'Remaining unrouted nets: ' + after.unrouted.join(', ') + '.' : 'All PCB nets are connected.';
    label('advancedRouteIssues',flagged ? 'Review the flagged issues before applying this preview for manual repair. ' + connections : connections);
    draw(true);
  }

  async function request(action, body) {
    const response = await fetch('/api/advanced-route/' + action, {method:'POST',
      headers:{'Content-Type':'application/json','X-CircuitPilot-App':'1'}, body:JSON.stringify(body)});
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(result.error || 'Advanced Route is unavailable.');
    return result;
  }

  function invalidate() {
    preview = undefined;
    $('advancedRouteResult').hidden = true;
    $('advancedRouteRepair').checked = false;
    updateApply();
  }

  function updateApply() {
    const flagged = !!preview?.issues.length, button = $('advancedRouteApply');
    button.disabled = !preview || (flagged && !$('advancedRouteRepair').checked);
    button.textContent = flagged ? 'Apply for repair' : 'Apply route';
  }

  function options() {
    const idx = Model.pinIndex(), count = new Map();
    for (const c of Pcb.placed()) for (const p of Pcb.padsOf(c,idx)) if (p.net) {
      count.set(p.net,(count.get(p.net) || 0) + 1);
    }
    const nets = [...count].filter(([,n]) => n === 2).map(([n]) => n).sort();
    for (const id of ['advancedRoutePositive','advancedRouteNegative']) {
      $(id).replaceChildren(new Option('Select net',''), ...nets.map(n => new Option(n,n)));
    }
    const r = Pcb.rules();
    $('advancedRouteGap').value = Math.max(Pcb.padCl(r),Pcb.viaCl(r),r.clearance,r.minClearance || 0);
  }

  function init() {
    if (!['127.0.0.1','localhost','[::1]'].includes(location.hostname)) return;
    const dialog = $('advancedRouteDialog'), run = $('advancedRouteRun'), form = $('advancedRouteForm');
    const fields = [...form.querySelectorAll('select,input')];
    const status = s => label('advancedRouteStatus',s);
    const setup = $('advancedRouteSetup');
    const button = $('btnAdvancedRoute');
    button.hidden = false;
    button.onclick = async () => {
      invalidate();
      options();
      run.disabled = true;
      setup.hidden = true;
      status(busy ? 'KiCadRoutingTools is routing this board…' : 'Checking the local router…');
      dialog.showModal();
      try {
        const r = await request('status',{});
        available = r.available;
        setup.hidden = available;
        label('advancedRouteFolder',r.folder);
        run.disabled = busy || !available;
        if (!busy) status('');
      } catch (e) {
        available = false;
        status(e.message);
      }
    };
    $('advancedRouteClose').onclick = () => dialog.close();
    form.oninput = () => {
      $('advancedRoutePair').hidden = $('advancedRouteMode').value !== 'pair';
      invalidate();
    };
    form.onsubmit = async e => {
      e.preventDefault();
      if (busy || !available) return;
      invalidate();
      try {
        const ctx = prepare(), snapshot = Model.snapshot(), started = performance.now();
        busy = run.disabled = true;
        fields.forEach(field => field.disabled = true);
        status('KiCadRoutingTools is routing this board…');
        const out = await request('run',ctx.body);
        if (!dialog.open) return;
        if (Model.snapshot() !== snapshot) throw new Error('The PCB changed while routing. Run another preview.');
        preview = {...candidate(ctx,out.board), snapshot};
        show();
        status('Route preview is ready in ' + ((performance.now()-started)/1000).toFixed(1) + ' s.');
      } catch (error) {
        invalidate();
        status(error.message);
      } finally {
        busy = false;
        fields.forEach(field => field.disabled = false);
        run.disabled = !available;
      }
    };
    $('advancedRouteBefore').onclick = () => { if (preview) draw(false); };
    $('advancedRouteAfter').onclick = () => { if (preview) draw(true); };
    $('advancedRouteRepair').onchange = updateApply;
    $('advancedRouteApply').onclick = () => {
      if (!preview || (preview.issues.length && !$('advancedRouteRepair').checked)) return;
      if (Model.snapshot() !== preview.snapshot) {
        invalidate();
        status('The PCB changed. Run another preview.');
        return;
      }
      try {
        const flagged = preview.issues.length > 0;
        Model.mutate(() => { Model.S.pcb = preview.pcb; });
        invalidate();
        dialog.close();
        if (flagged) $('btnDrc').click();
        App.toast(flagged ? 'Route applied for manual repair. Review the DRC list.' : 'Advanced route applied.');
      } catch (error) { status(error.message); }
    };
  }

  window.addEventListener('DOMContentLoaded',init);
})();
