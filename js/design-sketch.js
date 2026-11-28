'use strict';

// Marks are sent as compact design coordinates alongside the user's chat instruction.
const DesignSketch = (() => {
  const $ = id => document.getElementById(id);
  const ns = 'http://www.w3.org/2000/svg';
  const round = x => +x.toFixed(2);
  const point = p => p.map(round);
  const areaOf = ([a,b]) => [Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[0],b[0]),Math.max(a[1],b[1])];
  const midpoint = ([x0,y0,x1,y1]) => [(x0+x1)/2,(y0+y1)/2];
  let active, stroke, tool = 'circle';
  const marks = [];

  function designKey(view) {
    const S = Model.S;
    return JSON.stringify([Pcb.activePcb(),S.board,S.components.map(c=>[c.ref,c.footprint,c.pcb]),S.lib,
      view === 'enc' ? S.enclosure : [S.nets,S.pcb.traces,S.pcb.vias]]);
  }

  function readFrame(view) {
    const r = $('designSketchInk').getBoundingClientRect();
    const sketch = view === 'enc' ? EncView.sketchFrame() : [Pcb.vp?.cx,Pcb.vp?.cy,Pcb.vp?.s,PcbView.ui.active];
    return JSON.stringify([r.left,r.top,r.width,r.height,sketch]);
  }

  const text = message => $('designSketchStatus').textContent = message;
  const hint = view => view === 'pcb' ? 'Circle a part, then draw an arrow to its new position.' :
    'Circle a surface for a hole, or mark the enclosure part you want to change.';

  function draw() {
    const e = $('designSketchInk'), frag = document.createDocumentFragment();
    const colors = {circle:'#56e6dd',arrow:'#fbd05c',box:'#8cc8ff',pen:'#f799d4'};
    function svg(tag, attrs, parent) {
      const item = document.createElementNS(ns,tag);
      for (const [k,v] of Object.entries(attrs)) item.setAttribute(k,v);
      parent.append(item);
      return item;
    }
    const list = stroke ? [...marks,stroke] : marks;
    list.forEach(({kind,points},i)=>{
      const a=points[0], b=points.at(-1), [x,y,right,bottom]=areaOf([a,b]);
      const ink=colors[kind], g=svg('g',{stroke:ink,fill:'none','stroke-width':2.5,'stroke-linecap':'round','stroke-linejoin':'round'},frag);
      if (kind === 'circle') svg('ellipse',{cx:(x+right)/2,cy:(y+bottom)/2,rx:(right-x)/2,ry:(bottom-y)/2},g);
      else if (kind === 'box') svg('rect',{x,y,width:right-x,height:bottom-y,rx:2},g);
      else {
        svg('polyline',{points:points.map(p=>p.join(',')).join(' ')},g);
        if (kind === 'arrow') {
          const r=Math.atan2(b[1]-a[1],b[0]-a[0]), end=d=>[b[0]-11*Math.cos(r+d),b[1]-11*Math.sin(r+d)];
          svg('polyline',{points:[end(-.57),b,end(.57)].map(p=>p.join(',')).join(' ')},g);
        }
      }
      const label = [x+8, Math.max(11,y-11)];
      svg('circle',{cx:label[0],cy:label[1],r:9,fill:'#142231','stroke-width':1.5},g);
      svg('text',{x:label[0],y:label[1],fill:ink,stroke:'none','dominant-baseline':'central','text-anchor':'middle','font-size':11},g).textContent=i+1;
    });
    e.replaceChildren(frag);
    $('sketchUndo').disabled = $('sketchAttach').disabled = marks.length === 0;
  }

  function close() {
    if (!active) return;
    if (active.view === 'enc') EncView.freezeSketch(false);
    for (const id of ['pcbSketch','encSketch']) $(id).setAttribute('aria-pressed','false');
    for (const id of ['designSketchInk','designSketchBar']) $(id).classList.add('hidden');
    active = stroke = null;
    marks.length = 0;
    draw();
  }

  function open(view) {
    const same = active?.view === view;
    close();
    if (same) return;
    if (view === 'pcb' && !Model.S.board.w) { App.toast('Generate or open a PCB before drawing.'); return; }
    if (view === 'enc' && !EncView.sketchFrame()) { App.toast('Wait for the enclosure view to finish building.'); return; }
    if (view === 'pcb' && Pcb3D.ui.on) $('btn3d').click();
    if (view === 'enc') EncView.freezeSketch(true);
    for (const id of ['designSketchInk','designSketchBar']) $(id).classList.remove('hidden');
    $(view === 'pcb' ? 'pcbSketch' : 'encSketch').setAttribute('aria-pressed','true');
    active = {view,design:Model.S,frame:readFrame(view),key:designKey(view)};
    text(hint(view));
  }

  function current() {
    return active && active.design === Model.S && active.key === designKey(active.view) && active.frame === readFrame(active.view);
  }

  function boardDetails(mark, r, previous) {
    const toWorld = p => {
      const q = Pcb.vp.toWorld(p[0]+r.left,p[1]+r.top);
      return point([q.x,q.y]);
    };
    const {kind,points}=mark, path = points.map(toWorld), start=path[0], end=path.at(-1);
    const bounds = kind === 'pen' ? [Math.min(...path.map(p=>p[0])),Math.min(...path.map(p=>p[1])),
      Math.max(...path.map(p=>p[0])),Math.max(...path.map(p=>p[1]))] : areaOf([start,end]);
    const center=midpoint(bounds), layer=PcbView.ui.active;
    const side=c=>Pcb.isBottom(c) ? 'bottom' : 'top';
    const visible=Pcb.placed().filter(c=>['F','B'].includes(layer) && (layer==='B')===Pcb.isBottom(c) &&
      PcbView.ui.layers[Pcb.isBottom(c) ? 'B' : 'F']?.on);
    const part=c=>({ref:c.ref,side:side(c),center:point([c.pcb.x,c.pcb.y])});
    const nearby = p => visible.filter(c=>{
      const [x,y,x1,y1]=Pcb.fpBox(c,.25);
      return p[0]>=x && p[0]<=x1 && p[1]>=y && p[1]<=y1;
    }).sort((a,b)=>Math.hypot(a.pcb.x-p[0],a.pcb.y-p[1])-Math.hypot(b.pcb.x-p[0],b.pcb.y-p[1])).slice(0,8).map(part);
    const inside = (x,y) => kind === 'circle' ?
      ((x-center[0])/Math.max(.01,(bounds[2]-bounds[0])/2))**2+((y-center[1])/Math.max(.01,(bounds[3]-bounds[1])/2))**2 <= 1 :
      x>=bounds[0] && x<=bounds[2] && y>=bounds[1] && y<=bounds[3];
    if (kind==='arrow') {
      const from=nearby(start);
      const source=[...previous].reverse().find(m=>m.kind==='circle' && m.parts?.length===1 &&
        start[0]>=m.bounds[0]-.6 && start[0]<=m.bounds[2]+.6 && start[1]>=m.bounds[1]-.6 && start[1]<=m.bounds[3]+.6);
      return {from:start,to:end,to_inside_board:Pcb.inPoly(end[0],end[1],Pcb.boardPoly()),parts:source?.parts || from};
    }
    const parts=kind==='pen' ? nearby(center) : visible.filter(c=>inside(c.pcb.x,c.pcb.y)).slice(0,8).map(part);
    const nets=new Set();
    const sampled = path.filter((_,i)=>i===path.length-1 || i % Math.max(1,Math.ceil(path.length/13))===0);
    const probes = [...sampled,center];
    for (const t of Model.S.pcb.traces) {
      if (t.layer !== layer || !t.net) continue;
      if (t.pts.some(p=>inside(...p)) || t.pts.slice(1).some((b,i)=>probes.some(p=>Pcb.geom.ptSeg(p,t.pts[i],b)<=t.w/2+.35))) nets.add(t.net);
      if (nets.size>=8) break;
    }
    return {center:point(center),bounds,parts:parts.length ? parts : nearby(center),nearby_trace_nets:[...nets],
      ...(kind==='pen' ? {path:sampled}: {})};
  }

  function enclosureDetails({kind,points}, r) {
    const a=points[0], b=points.at(-1);
    const box=kind==='pen' ? [Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1])),
      Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))] : areaOf([a,b]);
    const hit=p=>EncView.sketchSurface(p[0]+r.left,p[1]+r.top,[box[0]+r.left,box[1]+r.top,box[2]+r.left,box[3]+r.top]);
    if (kind==='arrow') return {from:hit(a),to:hit(b)};
    return {surface:hit(midpoint(box))};
  }

  function attach() {
    if (!marks.length) return;
    if (!current()) { text('The view changed. Close drawing mode and draw the marks again.'); return; }
    const {view,key,design}=active, r=$('designSketchInk').getBoundingClientRect(), list=[];
    for (const m of marks) {
      const details=view==='pcb' ? boardDetails(m,r,list) : enclosureDetails(m,r);
      list.push({mark:list.length+1,kind:m.kind,...details});
    }
    if (view==='enc' && !list.some(m=>m.surface || m.from || m.to)) {
      text('The drawing did not hit a printed surface. Mark the visible surface and try again.');
      return;
    }
    const header=view==='pcb' ? 'PCB, millimetres from top-left, Y down. Active copper layer: '+PcbView.ui.active :
      'Enclosure, '+Enclosure.mode()+' mode. Millimetres in the model frame, Z up. A surface point is on the pictured printed part. Its normal gives the direction a perpendicular hole would follow. “cutout” contains exact positional arguments for add_enclosure_cutout in Box mode. “shape_index” identifies an editable custom design shape (zero-based).';
    const instructions=view==='pcb' ?
      'For a requested move, use place_footprint with the identified ref and the arrow’s to [x,y]. Keep its side unless asked to flip. If an arrow target is outside the board or the source has several parts, ask which placement is intended. For new parts, add them to the schematic then update PCB and use the marked destination. Only route or edit copper when requested or needed to restore affected nets.' :
      'Use the marked surface that corresponds to the user’s instruction. For a Box cutout, pass its cutout arguments plus the requested shape, width and height. For a round Custom 3D hole, use cut_enclosure_hole_at with the marked part as target, its point and normal, and the requested diameter and depth. To remove a design shape, use remove_enclosure_shape with shape_index and shape_name. Patch the saved script only for a scripted feature. A surface span is approximate. Use dimensions in the instruction or use the span if asked to use the drawn size. Ask if the mark or needed dimensions are unclear.';
    App.attachSketch({kind:'text',name:(view==='pcb'?'PCB':'Enclosure')+' drawing ('+list.length+')',
      sketchView:view,sketchGuard:()=>Model.S===design && designKey(view)===key,
      text:header+'\n'+instructions+'\nOnly make edits requested in the user’s message. Marks by themselves are context.\n'+JSON.stringify(list)});
    close();
    App.toast('Drawing attached. Tell the copilot what to change.');
  }

  function init() {
    const ink=$('designSketchInk');
    $('pcbSketch').onclick=()=>open('pcb');
    $('encSketch').onclick=()=>open('enc');
    $('sketchClose').onclick=close;
    $('sketchUndo').onclick=()=>{marks.pop();draw();text(hint(active.view));};
    $('sketchAttach').onclick=attach;
    document.querySelectorAll('[data-sketch]').forEach(b=>b.onclick=()=>{
      tool=b.dataset.sketch;
      document.querySelectorAll('[data-sketch]').forEach(q=>q.setAttribute('aria-pressed',String(q===b)));
    });
    const coordinate=e=>{
      const r=ink.getBoundingClientRect();
      return [e.clientX-r.left,e.clientY-r.top];
    };
    ink.addEventListener('wheel',e=>e.preventDefault(),{passive:false});
    ink.addEventListener('contextmenu',e=>e.preventDefault());
    ink.onpointerdown=e=>{
      if (!active || stroke || e.button!==0) return;
      if (!current()) { text('The view changed. Reopen drawing mode to make new marks.'); return; }
      if (marks.length>=12) { text('Attach these 12 marks before drawing more.'); return; }
      e.preventDefault();
      stroke={kind:tool,pointer:e.pointerId,points:[coordinate(e),coordinate(e)]};
      ink.setPointerCapture(e.pointerId);
      draw();
    };
    ink.onpointermove=e=>{
      if (stroke?.pointer!==e.pointerId) return;
      const p=coordinate(e), q=stroke.points.at(-1);
      if (stroke.kind==='pen' && Math.hypot(p[0]-q[0],p[1]-q[1])>=2 && stroke.points.length<256) stroke.points.push(p);
      else stroke.points[stroke.points.length-1]=p;
      draw();
    };
    ink.onpointerup=e=>{
      if (stroke?.pointer!==e.pointerId) return;
      stroke.points[stroke.points.length-1]=coordinate(e);
      if (stroke.points.some(p=>Math.hypot(p[0]-stroke.points[0][0],p[1]-stroke.points[0][1])>=5)) marks.push(stroke);
      stroke=null;
      draw();
      text(marks.length ? marks.length+' '+(marks.length===1?'mark':'marks')+' ready to attach.' : hint(active.view));
    };
    ink.onpointercancel=()=>{stroke=null;draw();};
    document.addEventListener('keydown',e=>{
      if (active && e.key==='Escape') { e.stopImmediatePropagation();e.preventDefault();close(); }
    },true);
    Model.subscribe(kind=>{ if (kind==='load') close(); });
  }

  window.addEventListener('DOMContentLoaded',init);
  return {close,viewChanged: view=>{if (active?.view!==view) close();}};
})();
