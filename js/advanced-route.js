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
  let busy = false;
  const routingSnapshot = ({board,pcb,nets,lib,rules,components,pcbs}) =>
    JSON.stringify([board,pcb,nets,lib,rules,components,pcbs?.map(p=>p.sheets),Pcb.activePcb()]);

  const pinned = v => v.manual || v.locked || v.thermal;
  const point = p => [p.x, p.y];
  const segments = traces => traces.flatMap(t => t.pts.slice(1).map((p,i) =>
    ({net: t.net || null, layer: t.layer, w: t.w, pts: [t.pts[i], p]})));

  function prepare(mode) {
    const S = Model.S, R = Pcb.rules(), parts = Pcb.placed();
    if (+R.layers !== 2) throw new Error('Advanced Route currently supports two-layer boards.');
    if (!S.board.w || !parts.length || Pcb.pendingFootprints().length) {
      throw new Error('Update from schematic and place the parts before routing.');
    }
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
      noViaInPad: !!R.noViaInPad, neckDown: !!R.neckDown,
      minWidth: +R.minTraceWidth || R.traceWidth, annular: +R.minAnnularRing || 0,
      holeClearance: Math.max(+R.minHoleToTrack || 0, +R.minPthToTrack || 0),
      seconds: +R.routeTime || 90
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
    return {body: {mode, board: rows.join('\n'), rules, widths, gap, skew}, pair, nets, tracks, vias, widthOf};
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
    const groups = new Map();
    const group = n => {
      if (!groups.has(n)) groups.set(n,{tracks:[],vias:[]});
      return groups.get(n);
    };
    const rules = ctx.body.rules;
    for (const q of t) {
      const width = ctx.pair.length ? rules.width : ctx.widthOf(q.net);
      group(q.net).tracks.push({...q, w: rules.neckDown ? Math.max(rules.minWidth,Math.min(q.w,width)) : width});
    }
    for (const q of v) group(q.net).vias.push({...q,d:rules.via,drill:rules.drill});

    const baseline = assess(original);
    let pcb = original, accepted = 0, failure;
    function attempt(nets) {
      const replace = new Set(nets), keep = q => pinned(q) || !replace.has(q.net);
      const next = {...pcb, traces: [...pcb.traces.filter(keep),...nets.flatMap(n=>groups.get(n).tracks)],
        vias: [...pcb.vias.filter(keep),...nets.flatMap(n=>groups.get(n).vias)], routed: {}};
      const after = assess(next);
      const errors = newErrors(baseline,after);
      const failed = after.unrouted.find(n => replace.has(n) || !baseline.unrouted.includes(n));
      if (errors.length || failed) {
        failure = errors[0]?.msg || 'Could not route ' + failed + ' with the current rules.';
        return false;
      }
      if (ctx.pair.length) {
        const lengths = ctx.pair.map(net=>next.traces.filter(q=>q.net===net).reduce((sum,q)=>
          sum+q.pts.slice(1).reduce((n,p,i)=>n+Math.hypot(p[0]-q.pts[i][0],p[1]-q.pts[i][1]),0),0));
        if (Math.abs(lengths[0]-lengths[1]) > ctx.body.skew + .000001) {
          failure = 'The pair exceeds the selected length difference.';
          return false;
        }
      }
      next.routed = after.routed;
      pcb = next;
      accepted += nets.length;
      return true;
    }
    // Try the complete route first. If some nets violate the selected rules, keep compliant batches.
    function applyBatches(nets) {
      if (attempt(nets) || nets.length < 2 || ctx.pair.length) return;
      const mid = Math.floor(nets.length/2);
      applyBatches(nets.slice(0,mid));
      applyBatches(nets.slice(mid));
    }
    if (ctx.pair.some(n=>!groups.has(n))) throw new Error('The router could not complete both nets of the pair.');
    applyBatches([...groups.keys()]);
    if (!accepted) throw new Error(failure || 'No routes met the selected board rules.');
    return {pcb, check: assess(pcb), engine: 'advanced'};
  }

  function newErrors(before, after) {
    const signature = q => JSON.stringify([q.type,q.msg,q.x,q.y]);
    const known = new Map();
    for (const q of before.errors) known.set(signature(q),(known.get(signature(q)) || 0) + 1);
    return after.errors.filter(q => {
      const k = signature(q), n = known.get(k);
      if (n) known.set(k,n-1);
      return !n;
    });
  }

  function assess(pcb) {
    const original = Model.S.pcb;
    try {
      Model.S.pcb = pcb;
      const conn = Pcb.connectivity(), drc = Pcb.drc();
      return {unrouted: Pcb.status(conn).unrouted,
        links: Object.values(conn).reduce((n,c)=>n + c.groups.length - 1,0),
        errors: drc.violations.filter(q=>q.severity==='error' && q.type!=='unrouted'),
        routed: Object.fromEntries(Object.entries(conn).filter(([,n])=>n.complete).map(([n])=>[n,true]))};
    } finally {
      Model.S.pcb = original;
    }
  }

  async function builtIn(design, before, progress) {
    const state = JSON.parse(JSON.stringify(design));
    const copperKeys = {
      traces: t => JSON.stringify([t.net,t.layer,t.w,t.pts]),
      vias: viaKey
    };
    const originals = Object.fromEntries(Object.entries(copperKeys).map(([kind,key]) => [
      kind, new Map(design.pcb[kind].filter(pinned).map(q=>[key(q),q]))
    ]));
    // The built-in router preserves hand-routed copper. Give locked and thermal copper the same protection.
    for (const kind of Object.keys(copperKeys)) {
      state.pcb[kind].forEach(q=>{ if (pinned(q)) q.manual = true; });
    }
    const pcb = await App.routeCandidate(state,{},progress);
    for (const [kind,key] of Object.entries(copperKeys)) {
      const fixed = originals[kind], returned = new Set(pcb[kind].map(key));
      if ([...fixed.keys()].some(k=>!returned.has(k))) throw new Error('The alternative route touched locked copper.');
      pcb[kind] = pcb[kind].map(q=>fixed.get(key(q)) || q);
    }
    const check = assess(pcb), errors = newErrors(before,check);
    if (errors.length) throw new Error(errors[0].msg);
    if (check.unrouted.some(n=>!before.unrouted.includes(n))) throw new Error('The alternative route left a previously closed net open.');
    return {pcb,check,engine:'built-in'};
  }

  async function request(action, body) {
    const response = await fetch('/api/advanced-route/' + action, {method:'POST',
      headers:{'Content-Type':'application/json','X-CircuitPilot-App':'1'}, body:JSON.stringify(body)});
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(result.error || 'Advanced Route is unavailable.');
    return result;
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
    const dialog = $('advancedRouteDialog'), form = $('advancedRouteForm');
    const button = $('btnAdvancedRoute'), pairButton = $('btnAdvancedPair');
    const fields = [...form.querySelectorAll('select,input,button')];
    button.hidden = false;
    pairButton.hidden = false;
    const pairStatus = text => $('advancedRouteStatus').textContent = text;
    const progress = $('advancedRouteProgress'), indicator = $('advancedRouteIndicator');
    const stage = $('advancedRouteStage'), summary = $('advancedRouteSummary');
    const done = $('advancedRouteDone'), drc = $('advancedRouteDrc');
    let timer;
    const paint = () => new Promise(resolve=>setTimeout(resolve,25));
    const quantity = (count, name) => count + ' ' + name + (count === 1 ? '' : 's');

    function startProgress() {
      const started = performance.now();
      const elapsed = () => $('advancedRouteElapsed').textContent = Math.floor((performance.now()-started)/1000) + ' s';
      stage.textContent = 'Reading the PCB and its rules…';
      indicator.hidden = false;
      summary.hidden = done.hidden = drc.hidden = true;
      progress.showModal();
      elapsed();
      timer = setInterval(elapsed,1000);
    }

    function finishProgress(title, detail, hasBoard) {
      clearInterval(timer);
      indicator.hidden = true;
      stage.textContent = title;
      summary.textContent = detail;
      summary.hidden = done.hidden = false;
      drc.hidden = !hasBoard;
      done.focus();
    }

    progress.addEventListener('cancel',e=>{ if (busy) e.preventDefault(); });
    done.onclick = () => progress.close();
    drc.onclick = () => { progress.close(); $('btnDrc').click(); };

    async function route(mode) {
      if (busy) return;
      const pair = mode === 'pair', rules = Pcb.rules(), design = Model.S;
      const nativeOnly = +rules.layers !== 2 || rules.trackStyle === '90';
      if (pair && nativeOnly) {
        pairStatus('Differential-pair routing requires a two-layer board with 45° tracks.');
        return;
      }
      busy = button.disabled = pairButton.disabled = true;
      fields.forEach(field=>field.disabled = true);
      startProgress();
      try {
        await paint();
        if (!design.board.w || !Pcb.placed().length || Pcb.pendingFootprints().length) {
          throw new Error('Update the PCB from its schematic and place the parts before routing.');
        }
        const before = assess(design.pcb);
        if (!pair && !before.unrouted.length) {
          finishProgress('Already routed', before.links ? 'No open nets were found.' :
            'The board has no unrouted connections. Existing copper was kept.',true);
          return;
        }
        const snapshot = routingSnapshot(design);
        const stillCurrent = () => Model.S === design && routingSnapshot(design) === snapshot;
        let best, issue;
        if (!nativeOnly) {
          const ctx = prepare(mode);
          stage.textContent = 'Routing with the Advanced Route engine…';
          try {
            const out = await request('run',ctx.body);
            if (!stillCurrent()) throw new Error('The board or its rules changed while routing.');
            stage.textContent = 'Checking the returned copper against your PCB rules…';
            await paint();
            if (!stillCurrent()) throw new Error('The board or its rules changed while routing.');
            best = candidate(ctx,out.board);
          } catch (e) {
            if (pair || !stillCurrent()) throw e;
            issue = e.message;
          }
        }
        if (!pair && (!best || best.check.unrouted.length)) {
          stage.textContent = nativeOnly ? 'Routing with the built-in router for these board rules…' :
            'Trying the built-in router to close remaining connections…';
          try {
            const alternate = await builtIn(design,before,m=>{
              if (m.net) stage.textContent = 'Built-in router · routing ' + m.net + '…';
            });
            if (!best || alternate.check.unrouted.length < best.check.unrouted.length ||
                (alternate.check.unrouted.length === best.check.unrouted.length && alternate.check.links < best.check.links)) {
              best = alternate;
            }
          } catch (e) { issue = [issue,e.message].filter(Boolean).join(' '); }
        }
        if (!stillCurrent()) throw new Error('The board or its rules changed while routing. Run Advanced Route again.');
        const improved = best && best.check.links < before.links;
        if (!best || (!pair && !improved)) {
          finishProgress('No new connections', 'Existing copper was kept. ' + (issue ||
            quantity(before.unrouted.length,'net') + ' still open under the selected rules.'),true);
          return;
        }
        Model.mutate(() => { Model.S.pcb = best.pcb; });
        Pcb.ui.drc = null;
        if (pair) dialog.close();
        const count = before.links - best.check.links;
        const remaining = best.check.unrouted.length;
        const detail = (count > 0 ? quantity(count,'connection') + ' added. ' : '') + quantity(remaining,'net') + ' still open.' +
          (best.engine === 'built-in' ? ' Used the built-in router for the applied result.' : '');
        finishProgress(remaining ? 'Routing finished with open nets' : 'Routing complete',detail,true);
      } catch (error) {
        finishProgress('Routing could not finish',error.message,!!Model.S.board.w);
      } finally {
        busy = button.disabled = pairButton.disabled = false;
        fields.forEach(field=>field.disabled = false);
      }
    }
    button.onclick = () => route('general');
    pairButton.onclick = () => {
      options();
      pairStatus('');
      dialog.showModal();
    };
    $('advancedRouteClose').onclick = () => dialog.close();
    form.onsubmit = e => {
      e.preventDefault();
      route('pair');
    };
  }

  window.addEventListener('DOMContentLoaded',init);
})();
