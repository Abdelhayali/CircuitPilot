'use strict';

const PcbBlanks = (() => {
  const $ = id => document.getElementById(id);
  const sizes = {small:[30,24],medium:[50,35],large:[70,45]};
  const gap = (a,b) => Math.hypot(a.x-b.x,a.y-b.y);

  function template(size,usb) {
    const [w,h] = sizes[size], copperInset = .35;
    const holes = [{x:3,y:h-3,d:3},{x:w-3,y:h-3,d:3}];
    const port = usb ? {x:w-4,y:h/2,rot:0} : null;
    const header = usb ? Lib.footprint('PinHeader_1x4').pads.map(p=>({
      pin:String(p.num), x:port.x+p.x, y:+(port.y+p.y).toFixed(3), d:p.w, drill:p.drill
    })) : [];
    const sites=[];
    for(let y=4;y<=h-4;y+=5) for(let x=4;x<=w-4;x+=5) {
      const large=(x+y)%2!==0;
      const p={x,y,d:large?1.3:.9,drill:large?.65:.4};
      if (holes.some(q=>gap(q,p)<q.d/2+p.d/2+.65) || header.some(q=>gap(q,p)<q.d/2+p.d/2+.8)) continue;
      sites.push(p);
    }
    return {version:1,id:'PB-'+w+'x'+h+(usb?'-USB4':'')+'-R1',w,h,thickness:1.6,copperInset,sites,header,port,holes};
  }

  function fabFiles(b) {
    const xy=p=>'X'+Math.round(p.x*1e6)+'Y'+Math.round((b.h-p.y)*1e6);
    const rectangle=(e=0)=>[{x:e,y:e},{x:b.w-e,y:e},{x:b.w-e,y:b.h-e},{x:e,y:b.h-e},{x:e,y:e}];
    const line=ps=>ps.map((p,i)=>xy(p)+(i?'D01*':'D02*'));
    const gerber=(fn,body,apertures=[])=>['G04 CircuitPilot PCB Blank '+b.id+'*','%TF.FileFunction,'+fn+'*%',
      '%FSLAX46Y46*%','%MOMM*%','%LPD*%','%ADD10C,0.100000*%',...apertures,'G01*','D10*',...body,'M02*'].join('\n')+'\n';
    const region=e=>['G36*',...line(rectangle(e)),'G37*'];
    const copper=fn=>{
      const aps=b.holes.map((p,i)=>'%ADD'+(11+i)+'C,'+(p.d+2*b.copperInset).toFixed(6)+'*%');
      const remove=b.holes.flatMap((p,i)=>['D'+(11+i)+'*',xy(p)+'D03*']);
      return gerber(fn,[...region(b.copperInset),'%LPC*%',...remove,'%LPD*%'],aps);
    };
    const drills=(holes,kind)=>{
      const d=[...new Set(holes.map(h=>h.drill||h.d))].sort((a,b)=>a-b);
      const tools=d.map((n,i)=>'T'+(i+1)+'C'+n.toFixed(3));
      const hits=d.flatMap((n,i)=>['T'+(i+1),...holes.filter(p=>(p.drill||p.d)===n).map(p=>'X'+p.x.toFixed(3)+'Y'+(b.h-p.y).toFixed(3))]);
      return ['M48',';TYPE='+kind,'METRIC,TZ',...tools,'%','G90','G05',...hits,'M30',''].join('\n');
    };
    return {
      'board-F_Cu.gtl':copper('Copper,L1,Top'), 'board-B_Cu.gbl':copper('Copper,L2,Bot'),
      'board-F_Mask.gts':gerber('Soldermask,Top',region(0)), 'board-B_Mask.gbs':gerber('Soldermask,Bot',region(0)),
      'board-Edge_Cuts.gm1':gerber('Profile,NP',line(rectangle())),
      'board-PTH.drl':drills([...b.sites,...b.header],'PLATED'),
      'board-NPTH.drl':drills(b.holes,'NON_PLATED')
    };
  }

  function apply(blank,ref) {
    return Model.mutate(()=>{
      const S=Model.S, header=ref ? Model.comp(ref) : null;
      if (!S.components.length) throw new Error('Add the circuit to its schematic before mapping it to a blank.');
      if (ref && (!blank.port || !header || header.footprint!=='PinHeader_1x4')) {
        throw new Error('Choose a 1 × 4, 2.54 mm header from the open board.');
      }
      S.board = {w:blank.w,h:blank.h,stock:blank};
      S.rules = {...S.rules,preset:'cnc3018',layers:2,cnc:true,traceWidth:.55,powerTraceWidth:.7,
        minTraceWidth:.36,clearance:.45,edgeClearance:.7,minEdgeClearance:.5,noViaInPad:true,viaInPad:false,
        minHoleSize:.4,minViaDrill:.4,viaDrill:.65,minViaDiameter:.9,viaDiameter:1.3,minAnnularRing:.17,
        minPthRing:.25,minHoleToHole:.4,neckDown:true,maskExpansion:0};
      S.pcb = {traces:[],vias:[],routed:{},holes:blank.holes.map(h=>({...h,locked:true}))};
      if (header) {
        delete header.pcbEdge;
        header.pcb={...blank.port,side:'F',locked:true};
      }
      const result = Pcb.autoPlace({w:blank.w,h:blank.h});
      if (result?.fits === false || Pcb.pendingFootprints().length) throw new Error('The parts do not fit this blank. Choose a larger size.');
      Pcb.stockCheck();
      return Pcb.status();
    });
  }

  function init() {
    const dialog=$('pcbBlanksDialog'), select=$('blankSize'), option=$('blankUsb'), ref=$('blankHeader');
    const render=()=>{
      const b=template(select.value,option.checked), svg=$('blankMap');
      svg.setAttribute('viewBox',[-1,-1,b.w+2,b.h+2].join(' '));
      svg.innerHTML='<rect x="0" y="0" rx=".4" width="'+b.w+'" height="'+b.h+'" fill="#16464a" stroke="#64bcaf" stroke-width=".2"/>'+
        [...b.sites,...b.header,...b.holes].map(p=>{
          const ring=p.drill ? '<circle cx="'+p.x+'" cy="'+p.y+'" r="'+p.d/2+'" fill="'+(p.pin?'#ffc87a':'#7dd6c3')+'"/>' : '';
          return ring+'<circle cx="'+p.x+'" cy="'+p.y+'" r="'+(p.drill||p.d)/2+'" fill="#142434"/>';
        }).join('');
      $('blankSummary').textContent=b.id+' · '+b.sites.length+' plated via sites · two 3 mm registration holes'+(b.port?' · USB-C breakout header':'');
      const refs=Pcb.placed().map(c=>c.ref);
      const options=Model.S.components.filter(c=>c.footprint==='PinHeader_1x4' && (refs.includes(c.ref)||Pcb.onActivePcb(c)));
      const current=ref.value;
      ref.replaceChildren(new Option('Leave factory header unused',''),...options.map(c=>new Option(c.ref+' · '+c.value,c.ref)));
      if (options.some(c=>c.ref===current)) ref.value=current;
      $('blankHeaderRow').hidden=!b.port;
      $('blankStatus').textContent=Model.S.board.stock ? 'Current board uses '+Model.S.board.stock.id+'.' : '';
      $('blankMapApply').disabled=!Model.S.components.length;
      return b;
    };
    $('btnPcbBlanks').onclick=()=>{
      const stock=Model.S.board.stock;
      if (stock) {
        select.value=Object.keys(sizes).find(s=>sizes[s][0]===stock.w)||'small';
        option.checked=!!stock.port;
      }
      render();
      dialog.showModal();
    };
    $('blankClose').onclick=()=>dialog.close();
    select.onchange=option.onchange=render;
    $('blankFab').onclick=()=>{
      const b=template(select.value,option.checked);
      const files=fabFiles(b);
      files['README-fabricator.txt']=[
        'Reusable plated PCB Blank '+b.id,
        b.w+' x '+b.h+' mm, two-layer, 1.6 mm FR-4. Both copper faces must be exposed for isolation milling.',
        'Order with plated vias open, no via filling or tenting, no solder mask on either face, and no silkscreen.',
        'Use the separate plated drill and non-plated registration drill files. Confirm both faces have continuous copper and review the drill count in the fabricator preview.',
        b.port ? 'The four plated holes are a position for a separate standard-pitch USB-C breakout or a wired header. Do not assemble a USB-C receptacle onto this blank.' : 'No connector footprint is included.',
        'The raw blank has a continuous copper sheet on each face and the plated via holes join them. Finish both faces before applying power.',
      ].join('\n');
      App.download(b.id+'-factory.zip',makeZip(files),'application/zip');
      $('blankStatus').textContent='Factory files saved for '+b.id+'.';
    };
    $('blankMapApply').onclick=()=>{
      const b=template(select.value,option.checked);
      try {
        apply(b,b.port?ref.value:undefined);
        App.showView('pcb'); Pcb.fit();
        dialog.close();
        App.toast('Mapped to '+b.id+'. Click Route, then CNC to export both sides.',8500);
      } catch (e) { $('blankStatus').textContent=e.message; }
    };
  }

  window.addEventListener('DOMContentLoaded',init);
  return {template,fabFiles,apply};
})();
